import { appointmentEmailQueue, closeAppointmentEmailQueue } from "../queues/email-queue.js";

async function clearAllJobs() {
  console.log("Clearing all jobs from queue...\n");

  const counts = await appointmentEmailQueue.getJobCounts();
  console.log("Current job counts:", counts);

  // obliterate() removes ALL jobs and queue data from Redis
  await appointmentEmailQueue.obliterate({ force: true });

  const after = await appointmentEmailQueue.getJobCounts();
  console.log("After clearing:", after);
  console.log("\nAll jobs cleared!");

  await closeAppointmentEmailQueue();
  process.exit(0);
}

clearAllJobs().catch((err) => {
  console.error("Failed to clear jobs:", err);
  process.exit(1);
});
