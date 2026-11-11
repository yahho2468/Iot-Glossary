import { Hono } from 'hono'
import { cors } from 'hono/cors'

const app = new Hono()

app.use('/*', cors())

// 데이터베이스 초기화 및 안전한 마이그레이션 (누락된 컬럼 자동 추가)
app.get('/api/init', async (c) => {
  try {
    const db = c.env.DB
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS terms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        parent_slug TEXT,
        editor_name TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run()

    // 테이블 컬럼 목록을 조회하여 빠진 컬럼 자동 마이그레이션
    const { results } = await db.prepare(`PRAGMA table_info(terms)`).all()
    const columns = results ? results.map((col: any) => col.name) : []

    if (!columns.includes('parent_slug')) {
      await db.prepare(`ALTER TABLE terms ADD COLUMN parent_slug TEXT`).run()
    }
    if (!columns.includes('editor_name')) {
      await db.prepare(`ALTER TABLE terms ADD COLUMN editor_name TEXT`).run()
    }

    return c.json({ message: "데이터베이스 초기화 및 마이그레이션 완료" })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// 모든 문서 및 노드/링크 조회
app.get('/api/terms', async (c) => {
  try {
    const db = c.env.DB
    const { results } = await db.prepare("SELECT * FROM terms ORDER BY id DESC").all()
    
    const terms = results || []
    
    const nodes = terms.map((t: any) => ({
      id: t.id,
      slug: t.slug,
      title: t.title,
      parent_slug: t.parent_slug
    }))

    const links: any[] = []
    const slugToId = new Map(terms.map((t: any) => [t.slug, t.id]))

    for (const t of terms) {
      if (t.parent_slug && slugToId.has(t.parent_slug)) {
        links.push({
          source: slugToId.get(t.parent_slug),
          target: t.id
        })
      }
    }

    return c.json({ terms, nodes, links })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// 특정 문서 상세 조회
app.get('/api/terms/:slug', async (c) => {
  try {
    const db = c.env.DB
    const slug = c.req.param('slug')
    const term = await db.prepare("SELECT * FROM terms WHERE slug = ?").bind(slug).first()
    
    if (!term) {
      return c.json({ error: "문서를 찾을 수 없습니다." }, 404)
    }

    return c.json({ term })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// 문서 생성 및 수정 (UPSERT) - 빈 content 허용하도록 검증 로직 수정
app.post('/api/terms', async (c) => {
  try {
    const db = c.env.DB
    const body = await c.req.json()
    const { slug, title, content, parent_slug, editor_name } = body

    if (!slug || !title || content === undefined || content === null) {
      return c.json({ error: "필수 값이 누락되었습니다." }, 400)
    }

    const now = new Date().toISOString()

    await db.prepare(`
      INSERT INTO terms (slug, title, content, parent_slug, editor_name, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET
        title = excluded.title,
        content = excluded.content,
        parent_slug = excluded.parent_slug,
        editor_name = excluded.editor_name,
        updated_at = excluded.updated_at
    `).bind(slug, title, content, parent_slug || null, editor_name || '익명', now).run()

    return c.json({ message: "저장 완료", slug })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// 문서 삭제 기능
app.delete('/api/terms/:slug', async (c) => {
  try {
    const db = c.env.DB
    const slug = c.req.param('slug')

    await db.prepare("DELETE FROM terms WHERE slug = ?").bind(slug).run()

    return c.json({ message: "삭제 완료", slug })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

export default app