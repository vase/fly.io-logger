import { config, MongoClient } from "./deps.ts";
if (Deno.env.get("DENO_ENV") !== "production") {
  config({ export: true });
}
const baseUrl = "https://api.fly.io";

export interface AppsList {
  id: string;
  status: string;
  organization: {
    slug: string;
  };
}

interface LogObject {
  id: string;
  type: string;
  attributes: {
    timestamp: string;
    message: string;
    level: string;
    instance: string;
    region: string;
    meta: {
      region: string;
      instance: string;
    };
  };
}

// Retryable fetch wrapper
export async function rFetch(
  url: string,
  options: RequestInit,
  n: number,
): ReturnType<Response["json"]> {
  try {
    return (await fetch(url, options)).json();
  } catch (err) {
    if (n === 1) throw err;
    return rFetch(url, options, n - 1);
  }
}

// Connect to Mongo
const logDBClient = new MongoClient();
try {
  await logDBClient.connect(Deno.env.get("LOGGING_MONGO_URI") || "");
} catch (err) {
  console.log(err);
}
const logDB = logDBClient.database("flyAppLogs");

// Set up cache objects
let appsList: AppsList[] = [];
// Create mongo collection object cache
const appCollectionHash: { [k: string]: ReturnType<typeof logDB.collection> } =
  {};
// Create next_token cache object
const nextTokenCache: { [k: string]: string } = {};
// Create timeToNextCall cache object
const timeToNextCallCache: { [k: string]: number } = {};
// Create setTimeout Cache
const setTimeoutCache: { [k: string]: number } = {};

console.log("====== BOOT COMPLETE ======");

async function getLogsFor(
  appId: keyof typeof appCollectionHash,
): Promise<number> {
  const logRequest: { data: LogObject[]; meta: { next_token: string } } =
    await rFetch(
      `${baseUrl}/api/v1/apps/${appId}/logs?next_token=${
        nextTokenCache[appId]
      }`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${Deno.env.get("FLY_AUTH_TOKEN")}`,
        },
      },
      3,
    );

  const { data, meta: { next_token: nextToken } } = logRequest;

  // Update logs object
  const logs = data.map((logObject: LogObject) => ({
    appId,
    logId: logObject.id,
    type: logObject.type,
    logTimestamp: new Date(logObject.attributes.timestamp),
    insertionTimestamp: new Date(),
    message: logObject.attributes.message,
    level: logObject.attributes.level,
    instanceId: logObject.attributes.instance,
    region: logObject.attributes.region,
    serialisedOriginalJSON: JSON.stringify(logObject),
  }));

  if (logs.length > 0) {
    try {
      await appCollectionHash[appId].insertMany(logs, { ordered: false });
    } catch (err) {
      // log error
      console.log(err.message);
    }
  }

  /* update next token and next call time
   * If previous next token and current next token is different, then decrease timeout by 250ms, else increase by 250ms.
   * min time between calls: 250ms
   * max time between calls: 5000ms
   */
  if (!nextToken || nextTokenCache[appId] === nextToken) {
    if (timeToNextCallCache[appId] < 5000) timeToNextCallCache[appId] += 250;
  } else if (nextTokenCache[appId] !== nextToken) {
    if (timeToNextCallCache[appId] > 250) timeToNextCallCache[appId] -= 250;
    nextTokenCache[appId] = nextToken;
  }
  return setTimeout(
    async () => await getLogsFor(appId),
    timeToNextCallCache[appId],
  );
}

async function getLatestAppsList() {
  console.log("Refreshing apps list");
  // Get Apps
  const appsResponse: { data: { apps: { nodes: [] } } } = await rFetch(
    `${baseUrl}/graphql`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${Deno.env.get("FLY_AUTH_TOKEN")}`,
      },
      body: JSON.stringify({
        query: `query {
            apps(type: "container", first: 400, role: null) {
              nodes {
                id
                name
                deployed
                organization {
                    slug
                }
                currentRelease {
                    createdAt
                }
                status
              }
            }
          }`,
      }),
    },
    5,
  );
  try {
    appsList = appsResponse?.data?.apps?.nodes;
    if (Deno.env.get("ORG_REGEX")) {
      appsList = appsList.filter((e: { organization: { slug: string } }) =>
        e.organization.slug.match(new RegExp(`${Deno.env.get("ORG_REGEX")}`))
      );
    }

    for (const app of appsList) {
      // Create app key if doesn't exist in cache
      if (!appCollectionHash[app.id]) {
        appCollectionHash[app.id] = logDB.collection(app.id);
        await appCollectionHash[app.id].createIndexes({
          indexes: [
            {
              key: { logId: 1, logTimestamp: 1 },
              name: "logId_and_timestamp_unique_index",
              unique: true,
            },
            { key: { logTimestamp: 1 }, name: "logTimestamp_index" },
            { key: { instanceId: 1 }, name: "instanceId_index" },
            { key: { level: 1 }, name: "level_index" },
            { key: { message: "text" }, name: "message_text_index" },
          ],
        });
      }

      // Create next_token key if doesn't exist in cache
      if (!nextTokenCache[app.id]) {
        nextTokenCache[app.id] = "";
      }

      // Create timeToNextCall key if doesn't exist in cache
      if (!timeToNextCallCache[app.id]) {
        timeToNextCallCache[app.id] = 2000;
      }

      // Schedule first job if it hasn't been scheduled
      if (!setTimeoutCache[app.id]) {
        console.log(`Scheduling first run for ${app.id}`);
        setTimeoutCache[app.id] = await getLogsFor(app.id);
      }
    }
  } catch (err) {
    console.log(err);
  }
}

getLatestAppsList();
// Set up 10 minute re-retrieval of apps lists.
setInterval(getLatestAppsList, 600000);

// Update statedocument
setInterval(async () => {
  await logDB.collection("metalog").updateOne({ _id: "statedocument" }, {
    $set: {
      _id: "statedocument",
      nextTokenCache,
      timeToNextCallCache,
      setTimeoutCache,
      lastUpdated: new Date(),
    },
  }, { upsert: true });
}, 10000);
