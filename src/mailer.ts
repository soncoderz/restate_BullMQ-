// import sgMail from "@sendgrid/mail";
import type { AppointmentEmailPayload } from "./appointment-service.js";

// const sendGridApiKey = process.env.SENDGRID_API_KEY;
// const mailFromEmail = process.env.SENDGRID_FROM_EMAIL ?? process.env.MAIL_FROM;
// const mailFromName = process.env.SENDGRID_FROM_NAME ?? "Restate Appointment";

// if (sendGridApiKey) {
//   sgMail.setApiKey(sendGridApiKey);
// }

export type EmailSendResult =
  | { sent: true }
  | {
      sent: false;
      reason: string;
      statusCode?: number;
      responseBody?: unknown;
    };

export async function sendAppointmentBeforeEmail(
  appointment: AppointmentEmailPayload,
) {
  return sendAppointmentEmail({
    to: appointment.customerEmail,
    subject: `Nhac lich truoc 1 phut: ${appointment.service}`,
    text: [
      `Xin chao ${appointment.customerName},`,
      "",
      "Con 1 phut nua den lich hen cua ban.",
      `Ma lich: ${appointment.id}`,
      `Dich vu: ${appointment.service}`,
      `Thoi gian: ${appointment.startAt}`,
      appointment.note ? `Ghi chu: ${appointment.note}` : undefined,
    ]
      .filter(Boolean)
      .join("\n"),
  });
}

export async function sendAppointmentAtTimeEmail(
  appointment: AppointmentEmailPayload,
) {
  return sendAppointmentEmail({
    to: appointment.customerEmail,
    subject: `Den gio hen: ${appointment.service}`,
    text: [
      `Xin chao ${appointment.customerName},`,
      "",
      "Da den gio lich hen cua ban.",
      `Ma lich: ${appointment.id}`,
      `Dich vu: ${appointment.service}`,
      `Thoi gian: ${appointment.startAt}`,
      appointment.note ? `Ghi chu: ${appointment.note}` : undefined,
    ]
      .filter(Boolean)
      .join("\n"),
  });
}

export async function sendAppointmentAfterEmail(
  appointment: AppointmentEmailPayload,
) {
  return sendAppointmentEmail({
    to: appointment.customerEmail,
    subject: `Sau gio hen 1 phut: ${appointment.service}`,
    text: [
      `Xin chao ${appointment.customerName},`,
      "",
      "Lich hen cua ban da qua 1 phut.",
      `Ma lich: ${appointment.id}`,
      `Dich vu: ${appointment.service}`,
      `Thoi gian: ${appointment.startAt}`,
      appointment.note ? `Ghi chu: ${appointment.note}` : undefined,
    ]
      .filter(Boolean)
      .join("\n"),
  });
}

async function sendAppointmentEmail(message: {
  to: string;
  subject: string;
  text: string;
}): Promise<EmailSendResult> {
  console.info("Mock appointment email sent", {
    to: message.to,
    subject: message.subject,
    text: message.text,
  });
  return { sent: true };

  // Code cu gui SendGrid, tam comment de chi log ra console.
  // if (!sendGridApiKey || !mailFromEmail) {
  //   console.info("SendGrid env is missing; email skipped", {
  //     to: message.to,
  //     subject: message.subject,
  //     hasApiKey: Boolean(sendGridApiKey),
  //     hasFromEmail: Boolean(mailFromEmail),
  //   });
  //   return {
  //     sent: false,
  //     reason: "SendGrid env is missing",
  //   };
  // }

  // try {
  //   await sgMail.send({
  //     from: {
  //       email: mailFromEmail,
  //       name: mailFromName,
  //     },
  //     ...message,
  //   });
  // } catch (error) {
  //   const sendGridError = toSendGridError(error);
  //   console.error("SendGrid email failed", {
  //     to: message.to,
  //     subject: message.subject,
  //     statusCode: sendGridError.statusCode,
  //     response: sendGridError.responseBody,
  //   });

  //   if (sendGridError.statusCode === 401 || sendGridError.statusCode === 403) {
  //     return {
  //       sent: false,
  //       reason: "SendGrid authentication failed",
  //       statusCode: sendGridError.statusCode,
  //       responseBody: sendGridError.responseBody,
  //     };
  //   }

  //   throw error;
  // }

  // console.info("SendGrid email sent", {
  //   to: message.to,
  //   subject: message.subject,
  // });
  // return { sent: true };
}

// function toSendGridError(error: unknown) {
//   if (typeof error === "object" && error !== null) {
//     const candidate = error as {
//       code?: number;
//       response?: {
//         statusCode?: number;
//         body?: unknown;
//       };
//     };

//     return {
//       statusCode: candidate.code ?? candidate.response?.statusCode,
//       responseBody: candidate.response?.body,
//     };
//   }

//   return {
//     statusCode: undefined,
//     responseBody: undefined,
//   };
// }
