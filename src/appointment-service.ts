import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";
import {
  sendAppointmentAfterEmail,
  sendAppointmentAtTimeEmail,
  sendAppointmentBeforeEmail,
} from "./mailer.js";

export const AppointmentInput = z.object({
  customerName: z.string().min(1),
  customerEmail: z.string().email(),
  service: z.string().min(1),
  startAt: z.string().datetime(),
  note: z.string().optional(),
});

const ReminderInvocations = z.object({
  before: z.string(),
  atTime: z.string(),
  after: z.string(),
});

export const AppointmentState = AppointmentInput.extend({
  id: z.string(),
  status: z.enum(["booked", "arrived"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  arrivedAt: z.string().optional(),
  reminderInvocations: ReminderInvocations,
});

export type AppointmentInput = z.infer<typeof AppointmentInput>;
export type AppointmentState = z.infer<typeof AppointmentState>;

const STATE_KEY = "appointment";
const ONE_MINUTE_MS = 60_000;

export const appointmentEmailService = restate.service({
  name: "AppointmentEmail",
  handlers: {
    sendBefore: restate.createServiceHandler(
      { input: restate.serde.schema(AppointmentState) },
      async (_ctx: restate.Context, appointment) => {
        await sendAppointmentBeforeEmail(appointment);
      },
    ),
    sendAtTime: restate.createServiceHandler(
      { input: restate.serde.schema(AppointmentState) },
      async (_ctx: restate.Context, appointment) => {
        await sendAppointmentAtTimeEmail(appointment);
      },
    ),
    sendAfter: restate.createServiceHandler(
      { input: restate.serde.schema(AppointmentState) },
      async (_ctx: restate.Context, appointment) => {
        await sendAppointmentAfterEmail(appointment);
      },
    ),
  },
});

export const appointmentObject = restate.object({
  name: "Appointment",
  handlers: {
    create: restate.createObjectHandler(
      {
        input: restate.serde.schema(AppointmentInput),
        output: restate.serde.schema(AppointmentState),
      },
      async (ctx: restate.ObjectContext, input) => {
        const existing = await ctx.get<AppointmentState>(STATE_KEY);
        if (existing) {
          throw new restate.TerminalError(`Appointment ${ctx.key} already exists`);
        }

        const now = await ctx.date.toJSON();
        const appointment: AppointmentState = {
          id: ctx.key,
          ...input,
          status: "booked",
          createdAt: now,
          updatedAt: now,
          reminderInvocations: { before: "", atTime: "", after: "" },
        };

        appointment.reminderInvocations = await scheduleReminderEmails(ctx, appointment);
        ctx.set(STATE_KEY, appointment);
        return appointment;
      },
    ),

    update: restate.createObjectHandler(
      {
        input: restate.serde.schema(AppointmentInput),
        output: restate.serde.schema(AppointmentState),
      },
      async (ctx: restate.ObjectContext, input) => {
        const existing = await requireAppointment(ctx);
        const now = await ctx.date.toJSON();

        const updated: AppointmentState = {
          ...existing,
          ...input,
          status: "booked",
          arrivedAt: undefined,
          updatedAt: now,
        };
        updated.reminderInvocations = await reschedulePendingReminderEmails(ctx, existing, updated);
        ctx.set(STATE_KEY, updated);
        return updated;
      },
    ),

    markArrived: restate.createObjectHandler(
      { output: restate.serde.schema(AppointmentState) },
      async (ctx: restate.ObjectContext) => {
        const appointment = await requireAppointment(ctx);

        cancelReminderEmails(ctx, appointment.reminderInvocations);

        const updated: AppointmentState = {
          ...appointment,
          status: "arrived",
          arrivedAt: await ctx.date.toJSON(),
          updatedAt: await ctx.date.toJSON(),
        };
        ctx.set(STATE_KEY, updated);
        return updated;
      },
    ),
  },
});

async function requireAppointment(ctx: restate.ObjectContext) {
  const appointment = await ctx.get<AppointmentState>(STATE_KEY);
  if (!appointment) {
    throw new restate.TerminalError(`Appointment ${ctx.key} does not exist`);
  }
  return appointment;
}

async function scheduleReminderEmails(
  ctx: restate.ObjectContext,
  appointment: AppointmentState,
) {
  const nowMs = await ctx.date.now();
  const startMs = new Date(appointment.startAt).getTime();
  const emailClient = ctx.serviceSendClient(appointmentEmailService);

  const before = emailClient.sendBefore(
    appointment,
    restate.rpc.sendOpts({ delay: delayUntil(startMs - ONE_MINUTE_MS, nowMs) }),
  );
  const atTime = emailClient.sendAtTime(
    appointment,
    restate.rpc.sendOpts({ delay: delayUntil(startMs, nowMs) }),
  );
  const after = emailClient.sendAfter(
    appointment,
    restate.rpc.sendOpts({ delay: delayUntil(startMs + ONE_MINUTE_MS, nowMs) }),
  );

  return {
    before: await before.invocationId,
    atTime: await atTime.invocationId,
    after: await after.invocationId,
  };
}

async function reschedulePendingReminderEmails(
  ctx: restate.ObjectContext,
  existing: AppointmentState,
  updated: AppointmentState,
) {
  const nowMs = await ctx.date.now();
  const oldStartMs = new Date(existing.startAt).getTime();
  const newStartMs = new Date(updated.startAt).getTime();
  const emailClient = ctx.serviceSendClient(appointmentEmailService);
  const reminderInvocations = { ...existing.reminderInvocations };
//   const beforeSendAtMs = newStartMs - ONE_MINUTE_MS;
// const beforeDelayMs = delayUntil(beforeSendAtMs, nowMs);

// console.log({
//   beforeSendAtMs,
//   nowMs,
//   beforeDelayMs,
// });

  // console.log("Reschedule before reminder:", {
  //   oldStartAt: existing.startAt,
  //   newStartAt: updated.startAt,
  //   oldBeforeMs: oldStartMs - ONE_MINUTE_MS,
  //   newBeforeMs: newStartMs - ONE_MINUTE_MS,
  //   nowMs,
  //   oldBeforeInvocationId: existing.reminderInvocations.before,
  // });

  if (oldStartMs - ONE_MINUTE_MS > nowMs) {
    ctx.cancel(restate.InvocationIdParser.fromString(existing.reminderInvocations.before));
  }
  if (newStartMs - ONE_MINUTE_MS > nowMs) {
    const beforeDelayMs = delayUntil(newStartMs - ONE_MINUTE_MS, nowMs);
    // console.log("Schedule new before reminder:", {
    //   newBeforeDelayMs: beforeDelayMs + 1000, 
    // });

    const before = emailClient.sendBefore(
      updated,
      restate.rpc.sendOpts({ delay: beforeDelayMs }),
    );
    reminderInvocations.before = await before.invocationId;
    console.log("New before invocation id:", reminderInvocations.before);
  }

  if (oldStartMs > nowMs) {
    ctx.cancel(restate.InvocationIdParser.fromString(existing.reminderInvocations.atTime));
  }
  if (newStartMs > nowMs) {
    const atTime = emailClient.sendAtTime(
      updated,
      restate.rpc.sendOpts({ delay: delayUntil(newStartMs, nowMs) }),
    );
    reminderInvocations.atTime = await atTime.invocationId;
  }

  if (oldStartMs + ONE_MINUTE_MS > nowMs) {
    ctx.cancel(restate.InvocationIdParser.fromString(existing.reminderInvocations.after));
  }
  if (newStartMs + ONE_MINUTE_MS > nowMs) {
    const after = emailClient.sendAfter(
      updated,
      restate.rpc.sendOpts({ delay: delayUntil(newStartMs + ONE_MINUTE_MS, nowMs) }),
    );
    reminderInvocations.after = await after.invocationId;
  }

  return reminderInvocations;
}

function cancelReminderEmails(
  ctx: restate.ObjectContext,
  reminderInvocations: AppointmentState["reminderInvocations"],
) {
  ctx.cancel(restate.InvocationIdParser.fromString(reminderInvocations.before));
  ctx.cancel(restate.InvocationIdParser.fromString(reminderInvocations.atTime));
  ctx.cancel(restate.InvocationIdParser.fromString(reminderInvocations.after));
}

function delayUntil(targetMs: number, nowMs: number) {
  return Math.max(0, targetMs - nowMs);
}

export type AppointmentObject = typeof appointmentObject;
