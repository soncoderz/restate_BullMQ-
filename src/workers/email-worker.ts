  import "dotenv/config";
  import * as clients from "@restatedev/restate-sdk-clients";
  import { Worker, type Job } from "bullmq";
  import type { AppointmentObject } from "../appointment-service.js";
  import {
    sendAppointmentAfterEmail,
    sendAppointmentAtTimeEmail,
    sendAppointmentBeforeEmail,
    type EmailSendResult,
  } from "../mailer.js";
  import {
    AppointmentEmailJobData,
    closeAppointmentEmailQueue,
    EMAIL_QUEUE_NAME,
    type EmailReminderType,
  } from "../queues/email-queue.js";
  import { createRedisConnection } from "../queues/redis.js";

  const restateRuntimeUrl = process.env.RESTATE_RUNTIME_URL ?? "http://localhost:18080";
  const restateAuthToken = process.env.RESTATE_AUTH_TOKEN;
  const workerConcurrency = readPositiveIntEnv("EMAIL_WORKER_CONCURRENCY", 1);
  const rateLimitMax = readPositiveIntEnv("EMAIL_RATE_MAX", 50);
  const rateLimitDurationMs = readPositiveIntEnv("EMAIL_RATE_DURATION_MS", 100);
  const connection = createRedisConnection();

  const restateClient = clients.connect({
    url: restateRuntimeUrl,
    headers: restateAuthToken
      ? {
          Authorization: `Bearer ${restateAuthToken}`,
        }
      : undefined,
  });

  const worker = new Worker<AppointmentEmailJobData>(
    EMAIL_QUEUE_NAME,
    processEmailJob,
    {
      connection,
      concurrency: workerConcurrency,
      limiter: {
        max: rateLimitMax,
        duration: rateLimitDurationMs,
      },
    },
  );

  worker.on("completed", (job) => {
    console.info("Appointment email job completed", {
      jobId: job.id,
      reminder: job.data.reminder,
      appointmentId: job.data.appointment.id,
      version: job.data.appointment.version,
    });
  });

  worker.on("failed", (job, error) => {
    console.error("Appointment email job failed", {
      jobId: job?.id,
      reminder: job?.data.reminder,
      appointmentId: job?.data.appointment.id,
      version: job?.data.appointment.version,
      attemptsMade: job?.attemptsMade,
      error: error.message,
    });
  });

  console.info("Appointment email worker started", {
    queue: EMAIL_QUEUE_NAME,
    restateRuntimeUrl,
    workerConcurrency,
    rateLimitMax,
    rateLimitDurationMs,
  });

  async function processEmailJob(job: Job<AppointmentEmailJobData>) {
    const data = AppointmentEmailJobData.parse(job.data);
    const appointmentClient = restateClient.objectClient<AppointmentObject>(
      { name: "Appointment" },
      data.appointment.id,
    );
    const jobId = job.id ?? "";

    const delivery = await appointmentClient.startEmailDelivery({
      reminder: data.reminder,
      version: data.appointment.version,
      jobId,
    });

    if (!delivery.shouldSend) {
      console.info("Appointment email job skipped before send", {
        jobId,
        reminder: data.reminder,
        appointmentId: data.appointment.id,
        version: data.appointment.version,
        reason: delivery.reason,
      });
      return delivery;
    }

    try {
      const result = await sendEmailByReminder(data.reminder, data.appointment);

      await appointmentClient.recordEmailResult({
        reminder: data.reminder,
        version: data.appointment.version,
        jobId,
        result: toRecordableResult(result),
      });

      return result;
    } catch (error) {
      if (isFinalAttempt(job)) {
        await appointmentClient.recordEmailResult({
          reminder: data.reminder,
          version: data.appointment.version,
          jobId,
          result: {
            status: "failed",
            error: errorMessage(error),
          },
        });
      }

      throw error;
    }
  }

  function sendEmailByReminder(
    reminder: EmailReminderType,
    appointment: AppointmentEmailJobData["appointment"],
  ) {
    switch (reminder) {
      case "before":
        return sendAppointmentBeforeEmail(appointment);
      case "atTime":
        return sendAppointmentAtTimeEmail(appointment);
      case "after":
        return sendAppointmentAfterEmail(appointment);
    }
  }

  function toRecordableResult(result: EmailSendResult) {
    if (result.sent) {
      return {
        status: "sent" as const,
      };
    }

    return {
      status: "skipped" as const,
      reason: result.reason,
      statusCode: result.statusCode,
      responseBody: result.responseBody,
    };
  }

  function isFinalAttempt(job: Job) {
    const maxAttempts = job.opts.attempts ?? 1;
    return job.attemptsMade + 1 >= maxAttempts;
  }

  function readPositiveIntEnv(name: string, fallback: number) {
    const value = Number(process.env[name]);

    if (Number.isInteger(value) && value > 0) {
      return value;
    }

    return fallback;
  }

  function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }

  async function shutdown(signal: NodeJS.Signals) {
    console.info(`Stopping appointment email worker after ${signal}`);
    await worker.close();
    await closeAppointmentEmailQueue();
    await connection.quit();
  }

  process.once("SIGINT", (signal) => {
    void shutdown(signal).then(() => process.exit(0));
  });

  process.once("SIGTERM", (signal) => {
    void shutdown(signal).then(() => process.exit(0));
  });

