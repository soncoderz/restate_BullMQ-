import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";
import { enqueueAppointmentEmail } from "./queues/email-queue.js";

export const AppointmentInput = z.object({
  customerName: z.string().min(1),
  customerEmail: z.string().email(),
  service: z.string().min(1),
  startAt: z.string().datetime(),
  note: z.string().optional(),
});

const ReminderType = z.enum(["before", "atTime", "after"]);

const ReminderInvocations = z.object({
  before: z.string(),
  atTime: z.string(),
  after: z.string(),
});

const EmailDeliveryStatus = z.object({
  version: z.number().int().min(1),
  sent: z.boolean(),
  scheduled: z.boolean(),
  invocationId: z.string().optional(),
  jobId: z.string().optional(),
  scheduledAt: z.string().optional(),
  scheduledFor: z.string().optional(),
  queuedAt: z.string().optional(),
  startedAt: z.string().optional(),
  sentAt: z.string().optional(),
  skippedAt: z.string().optional(),
  failedAt: z.string().optional(),
  canceledAt: z.string().optional(),
  error: z.string().optional(),
});

const EmailStatus = z.object({
  before: EmailDeliveryStatus,
  atTime: EmailDeliveryStatus,
  after: EmailDeliveryStatus,
});

const AppointmentEvent = z.object({
  type: z.enum([
    "created",
    "updated",
    "marked_arrived",
    "email_scheduled",
    "email_cancelled",
    "email_queued",
    "email_started",
    "email_sent",
    "email_skipped",
    "email_failed",
  ]),
  at: z.string(),
  version: z.number().int().min(1),
  reminder: ReminderType.optional(),
  invocationId: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const AppointmentEmailPayload = AppointmentInput.extend({
  id: z.string(),
  version: z.number().int().min(1),
});

const EmailDeliveryRequest = z.object({
  reminder: ReminderType,
  version: z.number().int().min(1),
  jobId: z.string().min(1),
});

const EmailDeliveryStartResult = z.object({
  shouldSend: z.boolean(),
  reason: z.string().optional(),
});

const EmailDeliveryResult = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("sent"),
  }),
  z.object({
    status: z.literal("skipped"),
    reason: z.string(),
    statusCode: z.number().optional(),
    responseBody: z.unknown().optional(),
  }),
  z.object({
    status: z.literal("failed"),
    error: z.string(),
  }),
]);

const EmailDeliveryResultInput = EmailDeliveryRequest.extend({
  result: EmailDeliveryResult,
});

export const AppointmentState = AppointmentInput.extend({
  id: z.string(),
  version: z.number().int().min(1),
  status: z.enum(["booked", "arrived"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  arrivedAt: z.string().optional(),
  reminderInvocations: ReminderInvocations,
  emailStatus: EmailStatus,
  history: z.array(AppointmentEvent),
});

export type AppointmentInput = z.infer<typeof AppointmentInput>;
export type AppointmentEmailPayload = z.infer<typeof AppointmentEmailPayload>;
export type AppointmentState = z.infer<typeof AppointmentState>;
type ReminderType = z.infer<typeof ReminderType>;

const STATE_KEY = "appointment";
const ONE_MINUTE_MS = 60_000;
const REMINDER_TYPES: ReminderType[] = ["before", "atTime", "after"];

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
        const appointment: AppointmentState = appendHistory(
          {
            id: ctx.key,
            ...input,
            version: 1,
            status: "booked",
            createdAt: now,
            updatedAt: now,
            reminderInvocations: emptyReminderInvocations(),
            emailStatus: emptyEmailStatus(1),
            history: [],
          },
          {
            type: "created",
            at: now,
            details: { appointment: input },
          },
        );

        applyScheduleResult(
          appointment,
          await scheduleReminderEmails(ctx, appointment, now),
        );

        ctx.set(STATE_KEY, appointment);
        return appointment;
      },
    ),

    get: restate.createObjectHandler(
      { output: restate.serde.schema(AppointmentState) },
      async (ctx: restate.ObjectContext) => {
        return requireAppointment(ctx);
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

        const updated: AppointmentState = appendHistory(
          {
            ...existing,
            ...input,
            version: existing.version + 1,
            status: "booked",
            arrivedAt: undefined,
            updatedAt: now,
            reminderInvocations: emptyReminderInvocations(),
            emailStatus: emptyEmailStatus(existing.version + 1),
          },
          {
            type: "updated",
            at: now,
            details: {
              before: appointmentSnapshot(existing),
              after: {
                ...appointmentSnapshot(existing),
                ...input,
                version: existing.version + 1,
                status: "booked",
                arrivedAt: undefined,
                updatedAt: now,
              },
            },
          },
        );

        const scheduleResult = await reschedulePendingReminderEmails(
          ctx,
          existing,
          updated,
          now,
        );
        applyScheduleResult(updated, scheduleResult);

        ctx.set(STATE_KEY, updated);
        return updated;
      },
    ),

    markArrived: restate.createObjectHandler(
      { output: restate.serde.schema(AppointmentState) },
      async (ctx: restate.ObjectContext) => {
        const appointment = await requireAppointment(ctx);
        const now = await ctx.date.toJSON();

        const updated = appendHistory(
          {
            ...appointment,
            version: appointment.version + 1,
            status: "arrived",
            arrivedAt: now,
            updatedAt: now,
          },
          {
            type: "marked_arrived",
            at: now,
            details: {
              before: appointmentSnapshot(appointment),
              after: {
                ...appointmentSnapshot(appointment),
                version: appointment.version + 1,
                status: "arrived",
                arrivedAt: now,
                updatedAt: now,
              },
            },
          },
        );

        cancelPendingReminderEmails(ctx, updated, now, "appointment marked arrived");

        ctx.set(STATE_KEY, updated);
        return updated;
      },
    ),

    sendBefore: restate.createObjectHandler(
      {
        input: restate.serde.schema(AppointmentEmailPayload),
        output: restate.serde.schema(AppointmentState),
      },
      async (ctx: restate.ObjectContext, appointment) => {
        return sendReminderEmail(ctx, "before", appointment);
      },
    ),

    sendAtTime: restate.createObjectHandler(
      {
        input: restate.serde.schema(AppointmentEmailPayload),
        output: restate.serde.schema(AppointmentState),
      },
      async (ctx: restate.ObjectContext, appointment) => {
        return sendReminderEmail(ctx, "atTime", appointment);
      },
    ),

    sendAfter: restate.createObjectHandler(
      {
        input: restate.serde.schema(AppointmentEmailPayload),
        output: restate.serde.schema(AppointmentState),
      },
      async (ctx: restate.ObjectContext, appointment) => {
        return sendReminderEmail(ctx, "after", appointment);
      },
    ),

    startEmailDelivery: restate.createObjectHandler(
      {
        input: restate.serde.schema(EmailDeliveryRequest),
        output: restate.serde.schema(EmailDeliveryStartResult),
      },
      async (ctx: restate.ObjectContext, input) => {
        return startEmailDelivery(ctx, input);
      },
    ),

    recordEmailResult: restate.createObjectHandler(
      {
        input: restate.serde.schema(EmailDeliveryResultInput),
        output: restate.serde.schema(AppointmentState),
      },
      async (ctx: restate.ObjectContext, input) => {
        return recordEmailResult(ctx, input);
      },
    ),
  },
});

async function requireAppointment(ctx: restate.ObjectContext) {
  const appointment = await ctx.get<AppointmentState>(STATE_KEY);
  if (!appointment) {
    throw new restate.TerminalError(`Appointment ${ctx.key} does not exist`);
  }
  return normalizeAppointment(appointment);
}

async function scheduleReminderEmails(
  ctx: restate.ObjectContext,
  appointment: AppointmentState,
  now: string,
) {
  const nowMs = new Date(now).getTime();
  const appointmentClient = ctx.objectSendClient(appointmentObject, ctx.key);
  const scheduleResult = emptyScheduleResult(appointment.version);

  for (const reminder of REMINDER_TYPES) {
    const targetMs = reminderTargetMs(reminder, appointment.startAt);
    const payload = toEmailPayload(appointment);
    const call =
      reminder === "before"
        ? appointmentClient.sendBefore(
            payload,
            restate.rpc.sendOpts({ delay: delayUntil(targetMs, nowMs) }),
          )
        : reminder === "atTime"
          ? appointmentClient.sendAtTime(
              payload,
              restate.rpc.sendOpts({ delay: delayUntil(targetMs, nowMs) }),
            )
          : appointmentClient.sendAfter(
              payload,
              restate.rpc.sendOpts({ delay: delayUntil(targetMs, nowMs) }),
            );

    const invocationId = await call.invocationId;
    scheduleResult.reminderInvocations[reminder] = invocationId;
    scheduleResult.emailStatus[reminder] = {
      version: appointment.version,
      sent: false,
      scheduled: true,
      invocationId,
      scheduledAt: now,
      scheduledFor: new Date(targetMs).toJSON(),
    };
    scheduleResult.events.push({
      type: "email_scheduled",
      at: now,
      version: appointment.version,
      reminder,
      invocationId,
      details: { scheduledFor: new Date(targetMs).toJSON() },
    });
  }

  return scheduleResult;
}

async function reschedulePendingReminderEmails(
  ctx: restate.ObjectContext,
  existing: AppointmentState,
  updated: AppointmentState,
  now: string,
) {
  const nowMs = new Date(now).getTime();
  const appointmentClient = ctx.objectSendClient(appointmentObject, ctx.key);
  const scheduleResult = emptyScheduleResult(updated.version);

  for (const reminder of REMINDER_TYPES) {
    const existingTargetMs = reminderTargetMs(reminder, existing.startAt);
    const updatedTargetMs = reminderTargetMs(reminder, updated.startAt);
    const existingInvocationId = existing.reminderInvocations[reminder];

    if (existingTargetMs > nowMs && existingInvocationId) {
      ctx.cancel(restate.InvocationIdParser.fromString(existingInvocationId));
      scheduleResult.events.push({
        type: "email_cancelled",
        at: now,
        version: updated.version,
        reminder,
        invocationId: existingInvocationId,
        details: {
          reason: "appointment updated",
          cancelledVersion: existing.version,
        },
      });
    }

    if (updatedTargetMs <= nowMs) {
      scheduleResult.events.push({
        type: "email_skipped",
        at: now,
        version: updated.version,
        reminder,
        details: {
          reason: "scheduled time already passed",
          scheduledFor: new Date(updatedTargetMs).toJSON(),
        },
      });
      continue;
    }

    const payload = toEmailPayload(updated);
    const call =
      reminder === "before"
        ? appointmentClient.sendBefore(
            payload,
            restate.rpc.sendOpts({ delay: delayUntil(updatedTargetMs, nowMs) }),
          )
        : reminder === "atTime"
          ? appointmentClient.sendAtTime(
              payload,
              restate.rpc.sendOpts({ delay: delayUntil(updatedTargetMs, nowMs) }),
            )
          : appointmentClient.sendAfter(
              payload,
              restate.rpc.sendOpts({ delay: delayUntil(updatedTargetMs, nowMs) }),
            );

    const invocationId = await call.invocationId;
    scheduleResult.reminderInvocations[reminder] = invocationId;
    scheduleResult.emailStatus[reminder] = {
      version: updated.version,
      sent: false,
      scheduled: true,
      invocationId,
      scheduledAt: now,
      scheduledFor: new Date(updatedTargetMs).toJSON(),
    };
    scheduleResult.events.push({
      type: "email_scheduled",
      at: now,
      version: updated.version,
      reminder,
      invocationId,
      details: { scheduledFor: new Date(updatedTargetMs).toJSON() },
    });
  }

  return scheduleResult;
}

function cancelPendingReminderEmails(
  ctx: restate.ObjectContext,
  appointment: AppointmentState,
  now: string,
  reason: string,
) {
  for (const reminder of REMINDER_TYPES) {
    const status = appointment.emailStatus[reminder];
    const invocationId = appointment.reminderInvocations[reminder] || status.invocationId;

    if (!status.scheduled || status.sent || !invocationId) {
      continue;
    }

    ctx.cancel(restate.InvocationIdParser.fromString(invocationId));
    appointment.emailStatus[reminder] = {
      ...status,
      scheduled: false,
      canceledAt: now,
    };
    appointment.history.push({
      type: "email_cancelled",
      at: now,
      version: appointment.version,
      reminder,
      invocationId,
      details: { reason },
    });
  }
}

async function sendReminderEmail(
  ctx: restate.ObjectContext,
  reminder: ReminderType,
  payload: AppointmentEmailPayload,
) {
  const appointment = await requireAppointment(ctx);
  const now = await ctx.date.toJSON();

  if (appointment.version !== payload.version) {
    return saveStaleEmailSkipped(
      ctx,
      appointment,
      reminder,
      now,
      `stale email payload version ${payload.version}`,
    );
  }

  if (appointment.status === "arrived") {
    return saveEmailSkipped(ctx, appointment, reminder, now, "appointment already arrived");
  }

  if (appointment.emailStatus[reminder].sent) {
    return appointment;
  }

  try {
    const result = await ctx.run(
      `enqueue ${reminder} appointment email`,
      () =>
        enqueueAppointmentEmail({
          reminder,
          appointment: payload,
        }),
      { maxRetryAttempts: 3 },
    );

    appointment.emailStatus[reminder] = {
      ...appointment.emailStatus[reminder],
      scheduled: false,
      jobId: result.jobId,
      queuedAt: now,
      error: undefined,
    };
    appointment.history.push({
      type: "email_queued",
      at: now,
      version: appointment.version,
      reminder,
      invocationId: appointment.emailStatus[reminder].invocationId,
      details: { jobId: result.jobId },
    });
    appointment.updatedAt = now;

    ctx.set(STATE_KEY, appointment);
    return appointment;
  } catch (error) {
    appointment.emailStatus[reminder] = {
      ...appointment.emailStatus[reminder],
      sent: false,
      scheduled: false,
      failedAt: now,
      error: errorMessage(error),
    };
    appointment.history.push({
      type: "email_failed",
      at: now,
      version: appointment.version,
      reminder,
      invocationId: appointment.emailStatus[reminder].invocationId,
      details: { error: errorMessage(error), stage: "enqueue" },
    });
    appointment.updatedAt = now;

    ctx.set(STATE_KEY, appointment);
    return appointment;
  }
}

async function startEmailDelivery(
  ctx: restate.ObjectContext,
  input: z.infer<typeof EmailDeliveryRequest>,
) {
  const appointment = await requireAppointment(ctx);
  const now = await ctx.date.toJSON();

  if (appointment.version !== input.version) {
    const reason = `stale email job version ${input.version}`;
    saveStaleEmailSkipped(ctx, appointment, input.reminder, now, reason);
    return { shouldSend: false, reason };
  }

  if (appointment.status === "arrived") {
    const reason = "appointment already arrived";
    saveEmailSkipped(ctx, appointment, input.reminder, now, reason, {
      jobId: input.jobId,
    });
    return { shouldSend: false, reason };
  }

  if (appointment.emailStatus[input.reminder].sent) {
    return { shouldSend: false, reason: "email already sent" };
  }

  appointment.emailStatus[input.reminder] = {
    ...appointment.emailStatus[input.reminder],
    scheduled: false,
    jobId: input.jobId,
    startedAt: now,
    error: undefined,
  };
  appointment.history.push({
    type: "email_started",
    at: now,
    version: appointment.version,
    reminder: input.reminder,
    invocationId: appointment.emailStatus[input.reminder].invocationId,
    details: { jobId: input.jobId },
  });
  appointment.updatedAt = now;

  ctx.set(STATE_KEY, appointment);
  return { shouldSend: true };
}

async function recordEmailResult(
  ctx: restate.ObjectContext,
  input: z.infer<typeof EmailDeliveryResultInput>,
) {
  const appointment = await requireAppointment(ctx);
  const now = await ctx.date.toJSON();

  if (appointment.version !== input.version) {
    return saveStaleEmailSkipped(
      ctx,
      appointment,
      input.reminder,
      now,
      `stale email result version ${input.version}`,
    );
  }

  if (appointment.emailStatus[input.reminder].sent) {
    return appointment;
  }

  switch (input.result.status) {
    case "sent":
      appointment.emailStatus[input.reminder] = {
        ...appointment.emailStatus[input.reminder],
        sent: true,
        scheduled: false,
        jobId: input.jobId,
        sentAt: now,
        error: undefined,
      };
      appointment.history.push({
        type: "email_sent",
        at: now,
        version: appointment.version,
        reminder: input.reminder,
        invocationId: appointment.emailStatus[input.reminder].invocationId,
        details: { jobId: input.jobId },
      });
      appointment.updatedAt = now;

      ctx.set(STATE_KEY, appointment);
      return appointment;

    case "skipped":
      return saveEmailSkipped(
        ctx,
        appointment,
        input.reminder,
        now,
        input.result.reason,
        {
          jobId: input.jobId,
          statusCode: input.result.statusCode,
          responseBody: input.result.responseBody,
        },
      );

    case "failed":
      appointment.emailStatus[input.reminder] = {
        ...appointment.emailStatus[input.reminder],
        sent: false,
        scheduled: false,
        jobId: input.jobId,
        failedAt: now,
        error: input.result.error,
      };
      appointment.history.push({
        type: "email_failed",
        at: now,
        version: appointment.version,
        reminder: input.reminder,
        invocationId: appointment.emailStatus[input.reminder].invocationId,
        details: { jobId: input.jobId, error: input.result.error },
      });
      appointment.updatedAt = now;

      ctx.set(STATE_KEY, appointment);
      return appointment;
  }
}

function saveStaleEmailSkipped(
  ctx: restate.ObjectContext,
  appointment: AppointmentState,
  reminder: ReminderType,
  now: string,
  reason: string,
) {
  appointment.history.push({
    type: "email_skipped",
    at: now,
    version: appointment.version,
    reminder,
    details: { reason },
  });
  appointment.updatedAt = now;

  ctx.set(STATE_KEY, appointment);
  return appointment;
}

function saveEmailSkipped(
  ctx: restate.ObjectContext,
  appointment: AppointmentState,
  reminder: ReminderType,
  now: string,
  reason: string,
  details: Record<string, unknown> = {},
) {
  appointment.emailStatus[reminder] = {
    ...appointment.emailStatus[reminder],
    sent: false,
    scheduled: false,
    skippedAt: now,
    error: reason,
  };
  appointment.history.push({
    type: "email_skipped",
    at: now,
    version: appointment.version,
    reminder,
    invocationId: appointment.emailStatus[reminder].invocationId,
    details: { reason, ...details },
  });
  appointment.updatedAt = now;

  ctx.set(STATE_KEY, appointment);
  return appointment;
}

function applyScheduleResult(
  appointment: AppointmentState,
  scheduleResult: ReturnType<typeof emptyScheduleResult>,
) {
  appointment.reminderInvocations = scheduleResult.reminderInvocations;
  appointment.emailStatus = scheduleResult.emailStatus;
  appointment.history.push(...scheduleResult.events);
}

function emptyScheduleResult(version: number) {
  return {
    reminderInvocations: emptyReminderInvocations(),
    emailStatus: emptyEmailStatus(version),
    events: [] as AppointmentState["history"],
  };
}

function emptyReminderInvocations() {
  return {
    before: "",
    atTime: "",
    after: "",
  };
}

function emptyEmailStatus(version: number): AppointmentState["emailStatus"] {
  return {
    before: emptyEmailDeliveryStatus(version),
    atTime: emptyEmailDeliveryStatus(version),
    after: emptyEmailDeliveryStatus(version),
  };
}

function emptyEmailDeliveryStatus(version: number) {
  return {
    version,
    sent: false,
    scheduled: false,
  };
}

function appendHistory(
  appointment: AppointmentState,
  event: Omit<AppointmentState["history"][number], "version">,
) {
  appointment.history.push({
    ...event,
    version: appointment.version,
  });
  return appointment;
}

function normalizeAppointment(appointment: AppointmentState) {
  const version = appointment.version ?? 1;
  return {
    ...appointment,
    version,
    reminderInvocations: appointment.reminderInvocations ?? emptyReminderInvocations(),
    emailStatus: appointment.emailStatus ?? emptyEmailStatus(version),
    history: appointment.history ?? [],
  };
}

function toEmailPayload(appointment: AppointmentState): AppointmentEmailPayload {
  return {
    id: appointment.id,
    version: appointment.version,
    customerName: appointment.customerName,
    customerEmail: appointment.customerEmail,
    service: appointment.service,
    startAt: appointment.startAt,
    note: appointment.note,
  };
}

function appointmentSnapshot(appointment: AppointmentState) {
  return {
    id: appointment.id,
    version: appointment.version,
    customerName: appointment.customerName,
    customerEmail: appointment.customerEmail,
    service: appointment.service,
    startAt: appointment.startAt,
    note: appointment.note,
    status: appointment.status,
    createdAt: appointment.createdAt,
    updatedAt: appointment.updatedAt,
    arrivedAt: appointment.arrivedAt,
  };
}

function reminderTargetMs(reminder: ReminderType, startAt: string) {
  const startMs = new Date(startAt).getTime();
  switch (reminder) {
    case "before":
      return startMs - ONE_MINUTE_MS;
    case "atTime":
      return startMs;
    case "after":
      return startMs + ONE_MINUTE_MS;
  }
}

function delayUntil(targetMs: number, nowMs: number) {
  return Math.max(0, targetMs - nowMs);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export type AppointmentObject = typeof appointmentObject;
