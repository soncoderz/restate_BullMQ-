# Luong Xu Ly Restate + BullMQ

Tai lieu nay mo ta luong chay cua project, tung process lam gi, va trong moi
handler/hambien thi goi tiep ham nao.

## 1. Thanh Phan Chinh

Project co 5 thanh phan runtime:

```text
Client/Postman/curl
  -> Hono API server
  -> Bull-board dashboard
  -> Restate runtime
  -> BullMQ queue
  -> Redis
  -> Email worker
```

Vai tro:

```text
Hono API:
- Nhan HTTP request.
- Validate body bang Zod.
- Goi Restate object client.

Restate:
- Luu state appointment.
- Schedule 3 reminder: before, atTime, after.
- Cancel reminder khi update hoac arrived.
- Chong gui email cu bang version.
- Luu history email_scheduled/email_queued/email_started/email_sent/email_failed.

BullMQ:
- Nhan job gui email tu Restate.
- Luu job trong Redis.
- Retry/backoff khi worker throw error.
- Gioi han concurrency va rate limit.

Bull-board:
- Giao dien web de xem BullMQ queue.
- Doc waiting/active/completed/failed jobs tu Redis thong qua BullMQ queue.
- Chay chung trong Hono API tai /admin/queues.

Redis:
- Noi BullMQ luu waiting/active/completed/failed jobs.

Email worker:
- Lay job tu BullMQ.
- Hoi lai Restate co duoc gui khong.
- Goi mailer.
- Bao ket qua ve Restate.
```

## 2. Process Can Chay

Can chay 4 process:

```powershell
# Redis cho BullMQ
docker start redis_bullmq

# Restate runtime
docker run --rm -p 18080:8080 -p 9070:9070 --name restate-server docker.io/restatedev/restate:latest

# API server
npm run dev

# BullMQ worker
npm run dev:email-worker
```

Mo BullMQ dashboard:

```text
http://localhost:9080/admin/queues
```

Neu Restate chay bang Docker, register endpoint:

```powershell
npx @restatedev/restate deployments register http://host.docker.internal:9080/restate
```

## 3. So Do Tong Quan

```text
POST /api/appointments
  -> server.ts appointmentClient(id).create()
  -> appointment-service.ts create handler
  -> scheduleReminderEmails()
  -> Restate delayed sendBefore/sendAtTime/sendAfter

Toi gio reminder
  -> sendBefore/sendAtTime/sendAfter
  -> sendReminderEmail()
  -> enqueueAppointmentEmail()
  -> BullMQ Queue.add()
  -> Redis luu job

Email worker
  -> processEmailJob()
  -> Appointment.startEmailDelivery()
  -> sendEmailByReminder()
  -> mailer.ts sendAppointment...Email()
  -> Appointment.recordEmailResult()
```

## 4. Luong Tao Appointment

File: `src/server.ts`

Endpoint:

```text
POST /api/appointments
```

Call chain:

```text
app.post("/api/appointments")
  -> AppointmentInput.extend(...).parse(body)
  -> baseAppointmentId = payload.id ?? crypto.randomUUID()
  -> for index 1..appointmentsPerCreateRequest
       -> appointmentClient(appointmentId).create(appointmentInput)
```

Chi tiet:

```text
appointmentClient(id)
  -> restateClient.objectClient<AppointmentObject>({ name: "Appointment" }, id)
```

Nghia la moi appointment id se la mot Restate Object key rieng.

Hien tai code tao 500 appointment trong mot request:

```text
appointmentsPerCreateRequest = 500
```

Voi payload id `apt-1`, cac id duoc tao se co dang:

```text
apt-1-001
apt-1-002
...
apt-1-500
```

## 5. Restate Create Handler

File: `src/appointment-service.ts`

Handler:

```text
appointmentObject.handlers.create
```

Call chain:

```text
create(ctx, input)
  -> ctx.get("appointment")
  -> neu da ton tai: throw TerminalError
  -> ctx.date.toJSON()
  -> appendHistory(... type: "created")
  -> scheduleReminderEmails(ctx, appointment, now)
  -> applyScheduleResult(appointment, scheduleResult)
  -> ctx.set("appointment", appointment)
  -> return appointment
```

Ham quan trong:

```text
scheduleReminderEmails(ctx, appointment, now)
```

Ham nay dat lich 3 reminder bang Restate delayed invocation:

```text
before  = startAt - 1 phut
atTime  = startAt
after   = startAt + 1 phut
```

Call chain ben trong:

```text
scheduleReminderEmails()
  -> ctx.objectSendClient(appointmentObject, ctx.key)
  -> reminderTargetMs(reminder, appointment.startAt)
  -> delayUntil(targetMs, nowMs)
  -> appointmentClient.sendBefore/sendAtTime/sendAfter(
       payload,
       restate.rpc.sendOpts({ delay })
     )
  -> call.invocationId
  -> emailStatus[reminder].scheduled = true
  -> history push email_scheduled
```

O buoc nay **BullMQ chua duoc goi**. Restate chi moi dat lich delayed handler.

## 6. Khi Toi Gio Reminder

File: `src/appointment-service.ts`

Restate se goi mot trong 3 handler:

```text
sendBefore()
sendAtTime()
sendAfter()
```

Call chain:

```text
sendBefore(ctx, appointment)
  -> sendReminderEmail(ctx, "before", appointment)

sendAtTime(ctx, appointment)
  -> sendReminderEmail(ctx, "atTime", appointment)

sendAfter(ctx, appointment)
  -> sendReminderEmail(ctx, "after", appointment)
```

Ham chinh:

```text
sendReminderEmail(ctx, reminder, payload)
```

Call chain:

```text
sendReminderEmail()
  -> requireAppointment(ctx)
  -> ctx.date.toJSON()
  -> neu appointment.version != payload.version:
       -> saveStaleEmailSkipped()
  -> neu appointment.status == "arrived":
       -> saveEmailSkipped()
  -> neu emailStatus[reminder].sent == true:
       -> return appointment
  -> ctx.run("enqueue ...", () => enqueueAppointmentEmail(...))
  -> emailStatus[reminder].scheduled = false
  -> emailStatus[reminder].jobId = result.jobId
  -> emailStatus[reminder].queuedAt = now
  -> history push email_queued
  -> ctx.set("appointment", appointment)
```

Diem quan trong:

```text
Restate handler khong gui mail truc tiep.
Restate chi enqueue BullMQ job roi return nhanh.
```

Ly do dung `ctx.run`:

```text
enqueueAppointmentEmail() la side effect ben ngoai Restate.
ctx.run giup Restate quan ly retry/replay dung cach.
```

## 7. BullMQ Producer

File: `src/queues/email-queue.ts`

Ham Restate goi:

```text
enqueueAppointmentEmail(input)
```

Call chain:

```text
enqueueAppointmentEmail()
  -> AppointmentEmailJobData.parse(input)
  -> appointmentEmailJobId(appointment.id, version, reminder)
  -> appointmentEmailQueue.add("send", data, { jobId })
  -> return { jobId }
```

`AppointmentEmailJobData.parse(input)` validate payload truoc khi dua vao queue.

`appointmentEmailJobId(...)` tao id co dinh:

```text
appointment-email-{encodedAppointmentId}-{version}-{reminder}
```

Vi du:

```text
appointment-email-YXB0LTEtMDA3-1-before
```

Muc dich cua `jobId` co dinh:

```text
- Chong enqueue trung neu Restate retry/replay handler.
- Moi appointment/version/reminder chi co mot job logic.
```

Queue duoc tao o:

```text
appointmentEmailQueue = new Queue(EMAIL_QUEUE_NAME, { connection, defaultJobOptions })
```

`defaultJobOptions`:

```text
attempts:
- So lan BullMQ retry khi worker throw error.

backoff:
- Moi lan retry doi lau hon, tranh spam mail provider.

removeOnComplete:
- Don job thanh cong cu khoi Redis.

removeOnFail:
- Don job failed cu sau mot thoi gian.
```

## 8. Redis Connection

File: `src/queues/redis.ts`

Call chain:

```text
createRedisConnection()
  -> new Redis(process.env.REDIS_URL ?? "redis://localhost:6379")
  -> connection.on("error", ...)
  -> return connection
```

Ca producer va worker deu dung Redis connection nay.

Neu Redis chua chay, se gap loi:

```text
ECONNREFUSED 127.0.0.1:6379
```

## 9. BullMQ Worker Khoi Dong

File: `src/workers/email-worker.ts`

Command:

```powershell
npm run dev:email-worker
```

Call chain khi khoi dong:

```text
import "dotenv/config"
  -> doc .env

createRedisConnection()
  -> ket noi Redis

clients.connect({ url: restateRuntimeUrl })
  -> tao Restate client cho worker

new Worker(EMAIL_QUEUE_NAME, processEmailJob, options)
  -> bat dau lang nghe job trong Redis
```

Worker options:

```text
concurrency:
- So job xu ly song song trong 1 worker process.

limiter.max + limiter.duration:
- Gioi han toc do xu ly job.
- Vi du max 50 duration 1000 nghia la toi da 50 job/giay.
```

Event logs:

```text
worker.on("completed")
  -> log job thanh cong

worker.on("failed")
  -> log job fail mot attempt
```

## 10. Worker Xu Ly Mot Job

File: `src/workers/email-worker.ts`

Ham chinh:

```text
processEmailJob(job)
```

Call chain:

```text
processEmailJob(job)
  -> AppointmentEmailJobData.parse(job.data)
  -> restateClient.objectClient<AppointmentObject>({ name: "Appointment" }, appointment.id)
  -> appointmentClient.startEmailDelivery({ reminder, version, jobId })
  -> neu delivery.shouldSend == false:
       -> log skipped
       -> return delivery
  -> sendEmailByReminder(reminder, appointment)
  -> appointmentClient.recordEmailResult({
       reminder,
       version,
       jobId,
       result: toRecordableResult(result)
     })
  -> return result
```

Neu `sendEmailByReminder` throw error:

```text
catch error
  -> neu isFinalAttempt(job):
       -> appointmentClient.recordEmailResult({
            result: { status: "failed", error }
          })
  -> throw error
```

Vi worker throw error lai, BullMQ se retry neu con attempts.

## 11. Worker Hoi Restate Truoc Khi Gui

File: `src/appointment-service.ts`

Handler worker goi:

```text
startEmailDelivery(input)
```

Call chain:

```text
startEmailDelivery()
  -> requireAppointment(ctx)
  -> ctx.date.toJSON()
  -> neu appointment.version != input.version:
       -> saveStaleEmailSkipped()
       -> return { shouldSend: false, reason }
  -> neu appointment.status == "arrived":
       -> saveEmailSkipped()
       -> return { shouldSend: false, reason }
  -> neu emailStatus[reminder].sent == true:
       -> return { shouldSend: false, reason: "email already sent" }
  -> emailStatus[reminder].startedAt = now
  -> emailStatus[reminder].jobId = input.jobId
  -> history push email_started
  -> ctx.set("appointment", appointment)
  -> return { shouldSend: true }
```

Ly do can hoi Restate truoc khi gui:

```text
Job BullMQ co the bi tre.
Trong thoi gian do appointment co the da update hoac da arrived.
Restate la source of truth, nen worker phai hoi lai state moi nhat.
```

## 12. Worker Goi Mailer

File: `src/workers/email-worker.ts`

Ham:

```text
sendEmailByReminder(reminder, appointment)
```

Call chain:

```text
before
  -> sendAppointmentBeforeEmail(appointment)

atTime
  -> sendAppointmentAtTimeEmail(appointment)

after
  -> sendAppointmentAfterEmail(appointment)
```

File: `src/mailer.ts`

Call chain:

```text
sendAppointmentBeforeEmail()
  -> sendAppointmentEmail({ to, subject, text })

sendAppointmentAtTimeEmail()
  -> sendAppointmentEmail({ to, subject, text })

sendAppointmentAfterEmail()
  -> sendAppointmentEmail({ to, subject, text })
```

Hien tai `sendAppointmentEmail()` dang mock:

```text
for index 1..MAILS_PER_REMINDER
  -> console.info("Mock appointment email sent", ...)
  -> sleep(MAIL_SEND_INTERVAL_MS)
return { sent: true }
```

Nen neu:

```text
MAILS_PER_REMINDER = 100
MAIL_SEND_INTERVAL_MS = 1000
```

Thi moi job mat gan 100 giay moi cap nhat `sent: true`.

## 13. Worker Bao Ket Qua Ve Restate

File: `src/workers/email-worker.ts`

Sau khi mailer return:

```text
toRecordableResult(result)
```

Neu mailer return:

```text
{ sent: true }
```

Thi worker gui ve Restate:

```text
{ status: "sent" }
```

Neu mailer return:

```text
{ sent: false, reason: "..." }
```

Thi worker gui ve Restate:

```text
{ status: "skipped", reason: "..." }
```

Handler Restate:

```text
recordEmailResult(input)
```

Call chain:

```text
recordEmailResult()
  -> requireAppointment(ctx)
  -> ctx.date.toJSON()
  -> neu appointment.version != input.version:
       -> saveStaleEmailSkipped()
  -> neu emailStatus[reminder].sent == true:
       -> return appointment
  -> switch input.result.status
```

Case `sent`:

```text
emailStatus[reminder].sent = true
emailStatus[reminder].scheduled = false
emailStatus[reminder].sentAt = now
emailStatus[reminder].error = undefined
history push email_sent
ctx.set()
```

Case `skipped`:

```text
saveEmailSkipped()
  -> sent = false
  -> scheduled = false
  -> skippedAt = now
  -> error = reason
  -> history push email_skipped
```

Case `failed`:

```text
sent = false
scheduled = false
failedAt = now
error = input.result.error
history push email_failed
ctx.set()
```

## 14. Update Appointment

File: `src/server.ts`

Endpoint:

```text
PUT /api/appointments/:id
```

Call chain:

```text
app.put()
  -> AppointmentInput.parse(body)
  -> appointmentClient(id).update(payload)
```

File: `src/appointment-service.ts`

Handler:

```text
update(ctx, input)
```

Call chain:

```text
update()
  -> requireAppointment(ctx)
  -> ctx.date.toJSON()
  -> tao updated appointment voi version + 1
  -> appendHistory(type: "updated")
  -> reschedulePendingReminderEmails(ctx, existing, updated, now)
  -> applyScheduleResult(updated, scheduleResult)
  -> ctx.set("appointment", updated)
```

Ham:

```text
reschedulePendingReminderEmails()
```

Call chain:

```text
for reminder of before/atTime/after
  -> tinh existingTargetMs
  -> tinh updatedTargetMs
  -> neu old reminder con o tuong lai:
       -> ctx.cancel(oldInvocationId)
       -> history email_cancelled
  -> neu updatedTargetMs da qua:
       -> history email_skipped
       -> continue
  -> schedule delayed invocation moi
  -> history email_scheduled
```

Neu BullMQ job cu da duoc enqueue truoc khi update, worker van bi chan bang version:

```text
old job version = 1
appointment version sau update = 2
startEmailDelivery() thay version khac nhau
  -> skip stale email job
```

## 15. Mark Arrived

File: `src/server.ts`

Endpoint:

```text
POST /api/appointments/:id/arrived
```

Call chain:

```text
app.post("/api/appointments/:id/arrived")
  -> appointmentClient(id).markArrived()
```

File: `src/appointment-service.ts`

Handler:

```text
markArrived(ctx)
```

Call chain:

```text
markArrived()
  -> requireAppointment(ctx)
  -> ctx.date.toJSON()
  -> tao updated appointment status = "arrived"
  -> appendHistory(type: "marked_arrived")
  -> cancelPendingReminderEmails(ctx, updated, now, "appointment marked arrived")
  -> ctx.set("appointment", updated)
```

Ham:

```text
cancelPendingReminderEmails()
```

Call chain:

```text
for reminder of before/atTime/after
  -> neu status.scheduled va chua sent va co invocationId:
       -> ctx.cancel(invocationId)
       -> emailStatus[reminder].scheduled = false
       -> emailStatus[reminder].canceledAt = now
       -> history email_cancelled
```

Neu job da vao BullMQ truoc khi arrived, worker van goi:

```text
startEmailDelivery()
```

Restate thay:

```text
appointment.status == "arrived"
```

Va skip:

```text
saveEmailSkipped(reason: "appointment already arrived")
```

## 16. Get Appointment

Endpoint:

```text
GET /api/appointments/:id
```

Call chain:

```text
server.ts app.get()
  -> appointmentClient(id).get()
  -> appointment-service.ts get handler
  -> requireAppointment(ctx)
  -> normalizeAppointment(appointment)
  -> return appointment
```

Dung endpoint nay de xem email status:

```powershell
curl.exe http://localhost:9080/api/appointments/apt-1-007
```

## 17. Trang Thai Email

Moi reminder co mot object:

```json
{
  "version": 1,
  "sent": false,
  "scheduled": true
}
```

Y nghia cac trang thai hay gap:

```text
sent=false, scheduled=true:
- Restate da dat lich, chua toi gio reminder.

sent=false, scheduled=false, queuedAt co gia tri:
- Restate da enqueue job vao BullMQ.
- Worker chua gui xong.

sent=false, scheduled=false, startedAt co gia tri:
- Worker da bat dau xu ly job.

sent=true, sentAt co gia tri:
- Worker gui mail xong va da ghi ket qua ve Restate.

sent=false, skippedAt co gia tri:
- Bi skip do stale version, already arrived, hoac mailer tra ve sent=false.

sent=false, failedAt co gia tri:
- Worker gui loi va BullMQ retry het attempts.
```

## 18. Failure Va Retry

Co 2 loai loi:

```text
Loi enqueue BullMQ:
- Xay ra trong Restate sendReminderEmail().
- Vi du Redis chet tai thoi diem enqueue.
- Restate ctx.run se retry theo maxRetryAttempts.
- Neu van fail, state ghi email_failed stage = "enqueue".

Loi gui mail trong worker:
- Xay ra trong processEmailJob().
- Worker throw error.
- BullMQ retry theo EMAIL_JOB_ATTEMPTS.
- Chi o lan cuoi moi goi recordEmailResult(status: "failed").
```

## 19. Call Chain Ngan Gon Theo File

```text
src/server.ts
  POST /api/appointments
    -> appointmentClient(id).create()

  GET /api/appointments/:id
    -> appointmentClient(id).get()

  PUT /api/appointments/:id
    -> appointmentClient(id).update()

  POST /api/appointments/:id/arrived
    -> appointmentClient(id).markArrived()
```

```text
src/appointment-service.ts
  create()
    -> scheduleReminderEmails()
    -> applyScheduleResult()

  update()
    -> reschedulePendingReminderEmails()
    -> applyScheduleResult()

  markArrived()
    -> cancelPendingReminderEmails()

  sendBefore/sendAtTime/sendAfter()
    -> sendReminderEmail()
    -> enqueueAppointmentEmail()

  startEmailDelivery()
    -> requireAppointment()
    -> saveStaleEmailSkipped() hoac saveEmailSkipped() hoac mark started

  recordEmailResult()
    -> saveStaleEmailSkipped() hoac saveEmailSkipped() hoac mark sent/failed
```

```text
src/queues/email-queue.ts
  enqueueAppointmentEmail()
    -> AppointmentEmailJobData.parse()
    -> appointmentEmailJobId()
    -> appointmentEmailQueue.add()
```

```text
src/workers/email-worker.ts
  new Worker(..., processEmailJob)

  processEmailJob()
    -> AppointmentEmailJobData.parse()
    -> appointmentClient.startEmailDelivery()
    -> sendEmailByReminder()
    -> appointmentClient.recordEmailResult()

  sendEmailByReminder()
    -> sendAppointmentBeforeEmail()
    -> sendAppointmentAtTimeEmail()
    -> sendAppointmentAfterEmail()
```

```text
src/mailer.ts
  sendAppointmentBeforeEmail()
    -> sendAppointmentEmail()

  sendAppointmentAtTimeEmail()
    -> sendAppointmentEmail()

  sendAppointmentAfterEmail()
    -> sendAppointmentEmail()
```

## 20. Tom Tat Mot Cau

```text
Restate quyet dinh khi nao va co duoc gui hay khong;
BullMQ chi chiu trach nhiem xep hang, retry, rate limit va chay viec gui mail nen.
```

## 21. BullMQ Dashboard

File: `src/server.ts`

Dashboard duoc mount khi server khoi dong:

```text
createQueueDashboard(queueDashboardPath)
  -> new HonoAdapter(serveStatic)
  -> serverAdapter.setBasePath(basePath)
  -> createBullBoard({
       queues: [new BullMQAdapter(appointmentEmailQueue)]
     })
  -> serverAdapter.registerPlugin()
  -> app.route(queueDashboardPath, queueDashboard)
```

Mac dinh:

```text
QUEUE_DASHBOARD_PATH=/admin/queues
```

URL:

```text
http://localhost:9080/admin/queues
```

Dashboard nay xem duoc:

```text
- waiting jobs
- active jobs
- completed jobs
- failed jobs
- job data
- retry/remove/pause/resume queue actions
```

Luu y:

```text
Bull-board khong thay the worker.
No chi la UI doc queue/job tu Redis.
Muon job duoc xu ly van phai chay npm run dev:email-worker.
```
