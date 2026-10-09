// In-memory DynamoDB (dynalite) for local development and tests.
import dynalite from "dynalite";
import { DynamoDBClient, CreateTableCommand } from "@aws-sdk/client-dynamodb";

export async function startDynamo(tableName = "posmp-local") {
  const server = dynalite({ createTableMs: 0, deleteTableMs: 0, updateTableMs: 0 });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;

  // dynalite accepts any credentials; the SDK just needs some to sign with.
  process.env.AWS_REGION ||= "ap-southeast-1";
  process.env.AWS_ACCESS_KEY_ID ||= "local";
  process.env.AWS_SECRET_ACCESS_KEY ||= "local";
  process.env.DYNAMODB_ENDPOINT = endpoint;
  process.env.TABLE_NAME = tableName;

  await new DynamoDBClient({ endpoint }).send(
    new CreateTableCommand({
      TableName: tableName,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
    })
  );
  return { endpoint, close: () => new Promise((r) => server.close(r)) };
}
