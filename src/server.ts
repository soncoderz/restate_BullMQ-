import { serve } from "@hono/node-server";
import * as clients from "@restatedev/restate-sdk-clients";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { z } from "zod";
import { AppointmentInput, type AppointmentObject } from "./appointment-service.js";
import { restateEndpoint } from "./restate-endpoint.js";

const port = Number(process.env.PORT ?? 9080);
const restateRuntimeUrl = process.env.RESTATE_RUNTIME_URL ?? "http://localhost:18080";
const restateAuthToken = process.env.RESTATE_AUTH_TOKEN;
const publicRestateEndpoint =
  process.env.PUBLIC_RESTATE_ENDPOINT ?? `http://localhost:${port}/restate`;

const restateClient = clients.connect({
  url: restateRuntimeUrl,
  headers: restateAuthToken
    ? {
        Authorization: `Bearer ${restateAuthToken}`,
      }
    : undefined,
});

const app = new Hono();

app.use(logger());

app.get("/", (c) =>
  c.json({
    name: "Restate + Hono appointment backend",
    health: "/health",
    restateEndpoint: "/restate",
    api: {
      createAppointment: "POST /api/appointments",
      updateAppointment: "PUT /api/appointments/:id",
      markAppointmentArrived: "POST /api/appointments/:id/arrived",
    },
  }),
);

app.get("/health", (c) =>
  c.json({
    ok: true,
    restateRuntimeUrl,
    restateAuthConfigured: Boolean(restateAuthToken),
    publicRestateEndpoint,
  }),
);


app.post("/api/appointments", async (c) => {
  const body = await c.req.json().catch(() => undefined);
  const payload = AppointmentInput.extend({
    id: z.string().min(1).optional(),
  }).parse(body);

  const appointmentId = payload.id ?? crypto.randomUUID();
  const { id: _id, ...appointmentInput } = payload;
  const appointment = await appointmentClient(appointmentId).create(appointmentInput);

  return c.json(appointment, 201);
});

app.put("/api/appointments/:id", async (c) => {
  const body = await c.req.json().catch(() => undefined);
  const payload = AppointmentInput.parse(body);

  const appointment = await appointmentClient(c.req.param("id")).update(payload);

  return c.json(appointment);
});

app.post("/api/appointments/:id/arrived", async (c) => {
  const appointment = await appointmentClient(c.req.param("id")).markArrived();

  return c.json(appointment);
});

app.onError((err, c) => {
  if (err instanceof z.ZodError) {
    return c.json({ error: "Invalid request body", issues: err.issues }, 400);
  }

  console.error(err);
  return c.json({ error: err.message }, 500);
});

app.all("/restate", (c) => restateEndpoint(stripRestatePrefix(c.req.raw)));
app.all("/restate/*", (c) => restateEndpoint(stripRestatePrefix(c.req.raw)));

function appointmentClient(id: string) {
  return restateClient.objectClient<AppointmentObject>({ name: "Appointment" }, id);
}

function stripRestatePrefix(request: Request) {
  const url = new URL(request.url);
  url.pathname = url.pathname.replace(/^\/restate(?=\/|$)/, "") || "/";
  return new Request(url, request);
}

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Hono API listening on http://localhost:${info.port}`);
  console.log(`Register Restate endpoint: ${publicRestateEndpoint}`);
});

