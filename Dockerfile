FROM denoland/deno:distroless-1.11.5@sha256:a95d96befc9d7947d578e0936149bd1ac7e7317b079ffe17476aeee4b855f586
ENV DENO_ENV=production

WORKDIR /app

# Cache the dependencies as a layer (the following two steps are re-run only when deps.ts is modified).
# Ideally fetch deps.ts will download and compile _all_ external files used in main.ts.
COPY deps.ts .
RUN ["deno", "cache", "deps.ts"]

# These steps will be re-run upon each file change in your working directory:
ADD . .
# Compile the main app so that it doesn't need to be compiled each startup/entry.
RUN ["deno", "cache", "main.ts"]

# Optionally prefer not to run as root.
USER nonroot

CMD ["run", "--allow-net", "--allow-env", "main.ts"]