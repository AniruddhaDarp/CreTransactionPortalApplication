import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

let cached: DynamoDBDocumentClient | undefined;

/** Memoized DynamoDB DocumentClient (one per Lambda container). */
export function docClient(): DynamoDBDocumentClient {
  if (!cached) {
    cached = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return cached;
}

/** Test seam — override or reset the memoized client. */
export function setDocClient(client: DynamoDBDocumentClient | undefined): void {
  cached = client;
}
