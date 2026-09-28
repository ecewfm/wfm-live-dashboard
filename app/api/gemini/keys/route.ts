// app/api/gemini/keys/route.ts
// Settings > Zoho Integrations > AI Categorization (Gemini) key management.
// Goes through lib/geminiKeys.ts (service_role client) since wfm_gemini_keys
// has RLS enabled with no policies — the client-side Settings UI can't reach
// it directly with the anon key, unlike most other settings tables. GET only
// ever returns masked keys (lib/geminiKeys.ts's listGeminiKeysMasked()); the
// raw key is never sent back to the browser after creation. No secret check:
// matches this app's existing security posture (see the other force-*/zoho
// routes in this same directory).

import { listGeminiKeysMasked, addGeminiKey, deleteGeminiKey } from '@/lib/geminiKeys'

export async function GET() {
  try {
    const keys = await listGeminiKeysMasked()
    return Response.json({ keys })
  } catch (e: any) {
    console.error('[gemini/keys] list failed:', e)
    return Response.json({ error: e.message }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const apiKey: string | undefined = body?.apiKey
    const label: string | undefined = body?.label
    if (!apiKey || !apiKey.trim()) {
      return Response.json({ error: 'apiKey is required' }, { status: 400 })
    }
    await addGeminiKey(apiKey, label)
    const keys = await listGeminiKeysMasked()
    return Response.json({ keys })
  } catch (e: any) {
    console.error('[gemini/keys] add failed:', e)
    return Response.json({ error: e.message }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const id = searchParams.get('id')
    if (!id) return Response.json({ error: 'id is required' }, { status: 400 })
    await deleteGeminiKey(id)
    const keys = await listGeminiKeysMasked()
    return Response.json({ keys })
  } catch (e: any) {
    console.error('[gemini/keys] delete failed:', e)
    return Response.json({ error: e.message }, { status: 500 })
  }
}
