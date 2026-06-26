# fantasy-league
Football fantasy league game

## Local development

Prerequisites: Node.js, Docker.

### Start

```
npm install
docker compose up -d   # starts local Postgres on localhost:5432
cp .env.example .env   # only needed once
npm run db:migrate     # applies src/db/migrations to the database
npm run dev:api        # API server on http://localhost:3001, separate terminal (Ctrl+C to stop)
npm run dev:worker     # worker poll loop, separate terminal (Ctrl+C to stop)
npm run dev:worker:price-update  # monthly price update loop, separate terminal (Ctrl+C to stop)
npm run dev:web        # Next.js frontend on http://localhost:3000, separate terminal (Ctrl+C to stop)
```

### Stop

```
docker compose down    # stops and removes the Postgres container (data persists in its volume)
```

Add `-v` (`docker compose down -v`) to also delete the database volume and start fresh next time.

### Other commands

```
npm run typecheck      # tsc --noEmit
npm run db:generate    # generate a new migration after editing src/db/schema.ts
```
