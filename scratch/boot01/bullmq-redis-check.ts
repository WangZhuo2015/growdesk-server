import { Queue, Worker, QueueEvents } from "bullmq";

import { readTestEnvironment } from "./test-environment.js";

async function runBullMqRedisCheck() {
  const env = readTestEnvironment();
  const REDIS_HOST = "127.0.0.1";
  const REDIS_PORT = env.redisPort;
  const startTime = Date.now();
  console.log(`[${new Date().toISOString()}] Connecting BullMQ 5 to Redis 8 at ${REDIS_HOST}:${REDIS_PORT}...`);

  const connection = {
    host: REDIS_HOST,
    port: REDIS_PORT,
    password: env.password,
    maxRetriesPerRequest: null,
    retryStrategy: () => null,
    connectTimeout: 5000,
  };

  const queueName = `test_boot01_${env.token}`;
  let queue: Queue | null = null;
  let queueEvents: QueueEvents | null = null;
  let worker: Worker | null = null;
  let jobProcessed = false;

  try {
    queue = new Queue(queueName, { connection });
    queueEvents = new QueueEvents(queueName, { connection });

    worker = new Worker(
      queueName,
      async (job) => {
        console.log(`Worker received job ${job.id}:`, job.name, job.data);
        if (job.data.sampleKey !== "boot01_test_value") {
          throw new Error("Invalid job data received");
        }
        jobProcessed = true;
        return { status: "success", processedAt: new Date().toISOString() };
      },
      { connection }
    );

    await queueEvents.waitUntilReady();
    await worker.waitUntilReady();

    console.log("Adding side-effect-free test job to BullMQ queue...");
    const jobId = `job_boot01_${Date.now()}`;
    const job = await queue.add(
      "test_task",
      { sampleKey: "boot01_test_value", taskPurpose: "verify_bullmq_redis8" },
      { jobId, removeOnComplete: true }
    );

    console.log(`Job added with ID: ${job.id}`);

    // Wait for completion via queueEvents
    await job.waitUntilFinished(queueEvents, 10000);

    if (!jobProcessed) {
      throw new Error("Job completed event fired but worker did not process job!");
    }

    console.log("Job successfully processed by BullMQ Worker!");
  } finally {
    // Clean shutdown in finally block: ensures all sockets and timers are properly closed
    console.log("Closing BullMQ Worker, Queue, and QueueEvents...");
    const cleanup = await Promise.allSettled([worker?.close(), queue?.close(), queueEvents?.close()]);
    if (cleanup.some(result => result.status === "rejected")) throw new Error("Queue cleanup failed");
    console.log("All BullMQ connections cleanly closed.");
  }

  const durationMs = Date.now() - startTime;
  console.log(`BullMQ 5 + Redis 8 Queue/Worker Verification: PASSED in ${durationMs}ms`);
  console.log("Awaiting natural process exit (no process.exit(0) call)...");
}

runBullMqRedisCheck()
  .then(() => {
    // DO NOT call process.exit(0). Let Node.js event loop naturally drain and terminate.
  })
  .catch((err) => {
    console.error("BullMQ/Redis check failed (connection details suppressed)");
    process.exitCode = 1;
  });
