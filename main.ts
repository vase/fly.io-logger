import { config, MongoClient } from "./deps.ts";
if (Deno.env.get("DENO_ENV") !== "production") {
  config({ export: true });
}
const baseUrl = "https://api.fly.io";

// Get Apps
const appsRequest = await fetch(`${baseUrl}/graphql`, {
  method: "POST",
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
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${Deno.env.get("FLY_AUTH_TOKEN")}`,
  },
});

console.log(`Current Env: ${JSON.stringify(Deno.env.toObject())}`);
const logDBClient = new MongoClient();
await logDBClient.connect(Deno.env.get("LOGGING_MONGO_URI") || "");

const logDB = logDBClient.database("flyAppLogs");

interface AppsList {
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

const appsReponse = await appsRequest.json();
let appsList: AppsList[] = appsReponse?.data?.apps?.nodes || [];

if (Deno.env.get("ORG_REGEX")) {
  appsList = appsList.filter((e: { organization: { slug: string } }) =>
    e.organization.slug.match(new RegExp(`${Deno.env.get("ORG_REGEX")}`))
  );
}

// Create mongo collection object cache
const appCollectionHash: { [k: string]: ReturnType<typeof logDB.collection> } =
  {};

for (const app of appsList) {
  appCollectionHash[app.id] = logDB.collection(app.id);
  await appCollectionHash[app.id].createIndexes({
    indexes: [
      { key: { logId: 1 }, name: "logId_unique_index", unique: true },
      { key: { logTimestamp: 1 }, name: "logTimestamp_index" },
      { key: { instanceId: 1 }, name: "instanceId_index" },
      { key: { level: 1 }, name: "level_index" },
      { key: { message: "text" }, name: "message_text_index" },
    ],
  });
}

// Create next_token cache object
const nextTokenCache: { [k: string]: number } = Object.assign(
  {},
  appsList.reduce(
    (prev, curr) =>
      Object.assign(prev, (curr.status === "running") ? { [curr.id]: "" } : {}),
    {},
  ),
);

// Create timeToNextCall cache object
const timeToNextCallCache = Object.assign({}, nextTokenCache);
for (const key of Object.keys(timeToNextCallCache)) {
  timeToNextCallCache[key] = 2000;
}

async function getLogsFor(appId: keyof typeof appCollectionHash) {
  const logRequest = await (await fetch(
    `${baseUrl}/api/v1/apps/${appId}/logs?next_token=${nextTokenCache[appId]}`,
    {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${Deno.env.get("FLY_AUTH_TOKEN")}`,
      },
    },
  )).json();

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
      console.log(err);
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
  setTimeout(async () => await getLogsFor(appId), timeToNextCallCache[appId]);
}

console.log("====== BOOT COMPLETE ======");
for (const app of appsList) {
  console.log(`Started ${app.id}`);
  await getLogsFor(app.id);
}

// Update statedocument
setInterval(async () => {
  await logDB.collection("metalog").updateOne({ _id: "statedocument" }, {
    $set: {
      _id: "statedocument",
      nextTokenCache,
      timeToNextCallCache,
      lastUpdated: new Date(),
    },
  }, { upsert: true });
}, 10000);
