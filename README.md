# restate_BullMQ-

Restate keeps appointment state and reminder scheduling. BullMQ handles the slow
email delivery work in a separate worker process so Restate handlers can return
quickly.

## Run locally

Start Redis, Restate, the API, and the email worker:

```bash
npm run dev
npm run dev:email-worker
```

Required queue settings:

```env
REDIS_URL=redis://localhost:6379
EMAIL_WORKER_CONCURRENCY=10
EMAIL_RATE_MAX=50
EMAIL_RATE_DURATION_MS=1000
QUEUE_DASHBOARD_PATH=/admin/queues
```

`sendBefore`, `sendAtTime`, and `sendAfter` are still scheduled by Restate.
When each reminder fires, Restate enqueues one BullMQ job. The worker checks the
latest appointment state before sending, then records `email_sent`,
`email_skipped`, or `email_failed` back to Restate.

BullMQ dashboard:

```text
http://localhost:9080/admin/queues
```

## Project flow

Detailed call chain and state flow: [docs/flow.md](docs/flow.md)
