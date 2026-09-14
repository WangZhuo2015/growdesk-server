import { S3Client, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
if (process.env.S3_ENDPOINT !== 'http://127.0.0.1:59000' || process.env.S3_BUCKET !== 'growdesk-preview') throw new Error('Preview storage target mismatch');
const client = new S3Client({ endpoint: process.env.S3_ENDPOINT, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY } });
try {
  try { await client.send(new HeadBucketCommand({ Bucket: process.env.S3_BUCKET })); }
  catch (error) {
    if (error.$metadata?.httpStatusCode !== 404) throw error;
    await client.send(new CreateBucketCommand({ Bucket: process.env.S3_BUCKET }));
  }
  console.log('Independent preview bucket is ready.');
} finally { client.destroy(); }
