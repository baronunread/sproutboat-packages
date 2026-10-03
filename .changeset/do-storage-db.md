---
"@sproutboat/wire": minor
---

New `doDb` option and `--do-db` flag: Durable Object storage and alarms can live in their own SQLite file instead of the per-deployment database (baronunread/sproutboat#207). The platform points it at a per-project file so an object's state survives redeploys, as on Workers. Without it, behaviour is unchanged.
