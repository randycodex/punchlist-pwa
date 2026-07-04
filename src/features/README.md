# Feature Modules

Use these folders for parallel workstreams. Keep route files in `src/app` thin and move logic/components here over time.

- `projects`: project list and project-level actions
- `areas`: area list and area-level actions
- `inspection`: location/item/checkpoint flows
- `export`: PDF/export UX and orchestration
- `sync`: sync orchestration and conflict UI
- `auth`: sign-in/out and token lifecycle UI
- `collaboration`: shared projects, membership, realtime updates, and mutation-based sync

Rule: new work should prefer feature folders first, then wire from routes.
