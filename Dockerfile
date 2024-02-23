FROM denoland/deno:distroless-1.38.2@sha256:90b88cbc9bb1484085c7fae9e3f8ff6275c7bb15b716cdd137076a38394ff2c9
ENV DENO_ENV=production

WORKDIR /app

# Cache the dependencies as a layer (the following two steps are re-run only when deps.ts is modified).
# Ideally fetch deps.ts will download and compile _all_ external files used in main.ts.
COPY deps.ts .
RUN ["deno", "cache", "--unstable", "deps.ts"]

# These steps will be re-run upon each file change in your working directory:
ADD . .
# Compile the main app so that it doesn't need to be compiled each startup/entry.
RUN ["deno", "cache", "--unstable", "main.ts"]

# Optionally prefer not to run as root.
USER nonroot

CMD ["run", "--allow-net", "--unstable", "--allow-env", "main.ts"]