# Hermes Task API

Programmatic access to any project's Task Modal data — bugs, features, notes/updates, and system links. Built so tools can post their own updates to Hermes instead of someone remembering to do it by hand.

Every write goes through the same Convex mutations the app uses, so **notifications still fire** exactly as if the change was made in the UI (assignee alerts, manager oversight, @mentions in notes).

## Setup (one time)

1. In Vercel → Project → **Settings → Environment Variables**, add:
   - `TASK_API_KEY` = a long random secret (e.g. run `openssl rand -hex 24`)
2. Redeploy. Until the variable is set, the API returns `503`.
3. Deploy the Convex functions too (`npx convex deploy`) — the links endpoint uses a new mutation (`updateTaskLinks`).

## Authentication

Send the key on every request, either way:

```
x-api-key: YOUR_KEY
```
or
```
Authorization: Bearer YOUR_KEY
```

Missing/wrong key → `401`.

## Finding a task's endpoint

Open the project's Task Modal as Admin/Admin+ — the purple **API ACCESS** box shows the copyable URL for that task, e.g.

```
https://your-app.vercel.app/api/task?taskId=jd7abc123...
```

Or list all tasks to discover IDs:

```bash
curl -H "x-api-key: $KEY" "https://your-app.vercel.app/api/task"
# → [{ "taskId": "...", "title": "...", "status": "...", "assignee": "..." }, ...]
```

## Endpoints

Base: `/api/task?taskId=<TASK_ID>`

| Method | Query params | Body | Does |
|---|---|---|---|
| `GET` | — | — | Full task: `bugs[]`, `features[]`, `notes[]`, `milestones[]`, `systemLinks` (admin credentials are never returned) |
| `POST` | `resource=bug` | `{ name, description?, suggestedBy? }` | Report a bug |
| `POST` | `resource=feature` | `{ name, description?, suggestedBy? }` | Add a feature |
| `PATCH` | `resource=feature&id=<featureId>` | `{ name?, description?, status? }` | Edit a feature **or bug** (`status`: `"pending"` / `"completed"`) |
| `DELETE` | `resource=feature&id=<featureId>` | — | Delete a feature or bug |
| `POST` | `resource=note` | `{ text, writer?, writerEmail? }` | Add a note/update (supports `@Name` mentions) |
| `PATCH` | `resource=links` | `{ appscriptLink?, webappLink?, projectLink? }` | Set the task's system links |

Optional on writes: `actorName` / `actorEmail` (or `writer` / `writerEmail` for notes) — used in notification messages and to skip self-notifications, same as the UI. Defaults to `"API"`.

## Examples

Report a bug:

```bash
curl -X POST -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  "https://your-app.vercel.app/api/task?taskId=$TASK_ID&resource=bug" \
  -d '{"name":"Login button unresponsive","description":"Fails on mobile Safari","suggestedBy":"Monitoring Bot"}'
```

Post an update note:

```bash
curl -X POST -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  "https://your-app.vercel.app/api/task?taskId=$TASK_ID&resource=note" \
  -d '{"text":"Deployed v2.3 to production.","writer":"Deploy Bot"}'
```

Mark a bug fixed:

```bash
curl -X PATCH -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  "https://your-app.vercel.app/api/task?taskId=$TASK_ID&resource=bug&id=$FEATURE_ID" \
  -d '{"status":"completed","writer":"Deploy Bot"}'
```

Set system links:

```bash
curl -X PATCH -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  "https://your-app.vercel.app/api/task?taskId=$TASK_ID&resource=links" \
  -d '{"webappLink":"https://myapp.example.com","appscriptLink":"https://script.google.com/..."}'
```

Delete a feature:

```bash
curl -X DELETE -H "x-api-key: $KEY" \
  "https://your-app.vercel.app/api/task?taskId=$TASK_ID&resource=feature&id=$FEATURE_ID"
```

### From Google Apps Script

```javascript
function postHermesUpdate(text) {
  UrlFetchApp.fetch("https://your-app.vercel.app/api/task?taskId=TASK_ID&resource=note", {
    method: "post",
    contentType: "application/json",
    headers: { "x-api-key": "YOUR_KEY" },
    payload: JSON.stringify({ text: text, writer: "My Tool" }),
  });
}
```

## Responses

- `201` `{ ok: true, bug|feature|note: {...} }` on create (the returned object includes the generated `id` — keep it if you plan to edit/delete later)
- `200` `{ ok: true, ... }` on edit/delete
- `400` bad input · `401` bad key · `404` task/feature not found · `503` API key not configured
