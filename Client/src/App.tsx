import React, { useEffect, useMemo, useRef, useState } from 'react'
import * as d3 from 'd3'

interface Node {
  id: number
  slug: string
  title: string
  parent_slug?: string | null
  category?: string
  tags?: string[]
  linked_slugs?: string[]
  x?: number
  y?: number
  vx?: number
  vy?: number
  fx?: number | null
  fy?: number | null
}

interface Link {
  source: number | Node
  target: number | Node
}

interface TermDetail {
  id: number
  slug: string
  title: string
  content: string
  parent_slug?: string | null
  linked_slugs?: string[]
  category?: string | null
  tags?: string[] | string | null
  updated_at: string
}

const NODE_RADIUS = 14

// 카테고리 이름별 색상을 안정적으로 배정한다. 서로 다른 카테고리는 가능한 한 다른 색조를 사용한다.
const buildCategoryColorMap = (values: string[]) => {
  const categories = [...new Set(values.map(value => value.trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'ko'))
  const usedHues = new Set<number>()
  const colors = new Map<string, string>()

  categories.forEach(category => {
    let hash = 0
    for (let index = 0; index < category.length; index++) {
      hash = (hash * 31 + category.charCodeAt(index)) | 0
    }
    let hue = Math.abs(hash) % 360
    let attempts = 0
    while (usedHues.has(Math.round(hue)) && attempts < 360) {
      hue = (hue + 137.508) % 360
      attempts++
    }
    hue = Math.round(hue)
    usedHues.add(hue)
    colors.set(category, `hsl(${hue}, 68%, 43%)`)
  })

  return colors
}

const parseTags = (value?: string[] | string | null): string[] => {
  let values: string[] = []
  if (Array.isArray(value)) {
    values = value
  } else if (typeof value === 'string' && value.trim()) {
    try {
      const parsed: unknown = JSON.parse(value)
      values = Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : value.split(',')
    } catch {
      values = value.split(',')
    }
  }
  return [...new Set(values.map(tag => tag.trim()).filter(Boolean))]
}

const normalizeTerm = (term: any): TermDetail => ({
  ...term,
  category: typeof term.category === 'string' ? term.category : '',
  tags: parseTags(term.tags),
  linked_slugs: Array.isArray(term.linked_slugs) ? term.linked_slugs : [],
})

// Markdown Guide 형식의 문서 렌더링. 기존 HTML 저장 문서는 호환 처리한다.
const escapeHtml = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')

const safeExternalUrl = (value: string) => {
  const normalized = value.startsWith('www.') ? `https://${value}` : value
  return /^(https?:\/\/|data:image\/(png|jpeg|gif|webp|svg\+xml);base64,)/i.test(normalized) ? normalized : ''
}

const JIRA_BASE_URL = 'https://suholab.atlassian.net'
const JIRA_ISSUE_TITLE_OVERRIDES: Record<string, string> = {
  'NRF26-67': 'IoT 용어 사전 개발 기획'
}
const resolveWikiTarget = (target: string, terms: TermDetail[]) => {
  const normalized = target.trim().toLocaleLowerCase()
  return terms.find(term => term.slug.toLocaleLowerCase() === normalized || term.title.trim().toLocaleLowerCase() === normalized)
}

const renderInlineMarkdown = (source: string, terms: TermDetail[] = []) => {
  let text = escapeHtml(source)
  const tokens: string[] = []
  const keep = (html: string) => {
    const key = `\u0000DISCORD${tokens.length}\u0000`
    tokens.push(html)
    return key
  }

  // 코드, 이미지, 일반 링크, 위키 링크, Jira 이슈 링크를 먼저 보호한다.
  text = text.replace(/`([^`\n]+)`/g, (_match, code) => keep(`<code>${code}</code>`))
  text = text.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+|www\.[^\s)]+)\)/g, (_match, alt, rawUrl) => {
    const url = safeExternalUrl(rawUrl)
    return url ? keep(`<img src="${escapeHtml(url)}" alt="${alt}" style="max-width:100%;max-height:450px;border-radius:12px;margin:12px 0" />`) : alt
  })
  text = text.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, rawTarget, rawAlias) => {
    const term = resolveWikiTarget(rawTarget, terms)
    if (!term) return _match
    const label = escapeHtml((rawAlias || term.title).trim())
    return keep(`<a href="?term=${encodeURIComponent(term.slug)}" data-wikilink-slug="${escapeHtml(term.slug)}" class="wiki-link" style="color:#2563eb;text-decoration:underline;font-weight:600">${label}</a>`)
  })
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|www\.[^\s)]+)\)/g, (_match, label, rawUrl) => {
    const url = safeExternalUrl(rawUrl)
    return url ? keep(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" style="color:#2563eb;text-decoration:underline">${label}</a>`) : label
  })
  text = text.replace(/\b([A-Z][A-Z0-9]{1,19}-\d+)\b/g, (_match, issueKey) => {
    const url = `${JIRA_BASE_URL}/browse/${issueKey}`
    const title = JIRA_ISSUE_TITLE_OVERRIDES[issueKey]
    const label = title ? `${issueKey}: ${escapeHtml(title)}` : issueKey
    return keep(`<a href="${url}" target="_blank" rel="noopener noreferrer" class="jira-issue-link" style="color:#2563eb;text-decoration:underline;font-weight:600">${label}</a>`)
  })

  text = text.replace(/__\*\*\*(.+?)\*\*\*__/g, '<u><strong><em>$1</em></strong></u>')
  text = text.replace(/__\*\*(.+?)\*\*__/g, '<u><strong>$1</strong></u>')
  text = text.replace(/__\*(.+?)\*__/g, '<u><em>$1</em></u>')
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  text = text.replace(/__([^_\n]+)__/g, '<u>$1</u>')
  text = text.replace(/~~(.+?)~~/g, '<del>$1</del>')
  text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
  text = text.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>')
  return text.replace(/\u0000DISCORD(\d+)\u0000/g, (_match, index) => tokens[Number(index)] || '')
}

const markdownToHtml = (source: string, terms: TermDetail[] = []) => {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const output: string[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) { index++; continue }

    const codeStart = line.match(/^\s*```([a-zA-Z0-9+#._-]+)?\s*$/)
    if (codeStart) {
      index++
      const codeLines: string[] = []
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) codeLines.push(lines[index++])
      if (index < lines.length) index++
      const language = codeStart[1] ? ` class="language-${escapeHtml(codeStart[1])}"` : ''
      output.push(`<pre><code${language}>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
      continue
    }

    if (/^\s*>>>\s?/.test(line)) {
      const quoteLines: string[] = [line.replace(/^\s*>>>\s?/, '')]
      index++
      while (index < lines.length && lines[index].trim()) quoteLines.push(lines[index++])
      output.push(`<blockquote><p>${quoteLines.map(item => renderInlineMarkdown(item, terms)).join('<br />')}</p></blockquote>`)
      continue
    }
    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = []
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) quoteLines.push(lines[index++].replace(/^\s*>\s?/, ''))
      output.push(`<blockquote><p>${quoteLines.map(item => renderInlineMarkdown(item, terms)).join('<br />')}</p></blockquote>`)
      continue
    }

    const heading = line.match(/^\s*(#{1,6})\s+(.+)$/)
    if (heading) {
      const level = heading[1].length
      const headingSizes = ['2em', '1.6em', '1.3em', '1.15em', '1.05em', '0.95em']
      output.push(`<h${level} style="font-size:${headingSizes[level - 1]};font-weight:750;line-height:1.25;margin:0.85em 0 0.4em">${renderInlineMarkdown(heading[2], terms)}</h${level}>`)
      index++
      continue
    }
    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      output.push('<hr />')
      index++
      continue
    }

    if (/^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line)
      const pattern = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/
      const items: string[] = []
      while (index < lines.length && pattern.test(lines[index])) {
        items.push(`<li>${renderInlineMarkdown(lines[index++].replace(pattern, ''), terms)}</li>`)
      }
      output.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`)
      continue
    }

    const paragraph: string[] = []
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^\s*```/.test(lines[index]) &&
      !/^\s*>>>\s?/.test(lines[index]) &&
      !/^\s*>\s?/.test(lines[index]) &&
      !/^\s*#{1,6}\s+/.test(lines[index]) &&
      !/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(lines[index]) &&
      !/^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(lines[index])
    ) paragraph.push(lines[index++])
    output.push(`<p>${paragraph.map(line => renderInlineMarkdown(line, terms)).join('<br />')}</p>`)
  }
  return output.join('\n')
}

const extractWikiLinkedSlugs = (html: string, terms: TermDetail[], selfSlug = '') => {
  const doc = new DOMParser().parseFromString(html || '', 'text/html')
  const linked = new Set<string>()
  const add = (target: string) => {
    const term = resolveWikiTarget(target, terms)
    if (term && term.slug !== selfSlug) linked.add(term.slug)
  }

  doc.querySelectorAll('a[data-wikilink-slug]').forEach(anchor => {
    const slug = anchor.getAttribute('data-wikilink-slug') || ''
    if (slug && slug !== selfSlug && terms.some(term => term.slug === slug)) linked.add(slug)
  })
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
  const textNodes: Text[] = []
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text)
  textNodes.forEach(node => {
    if (node.parentElement?.closest('a,code,pre')) return
    for (const match of (node.nodeValue || '').matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) add(match[1])
  })
  return [...linked]
}

// 예전 에디터가 저장한 HTML을 유지하되 허용된 태그/속성만 남겨 안전하게 표시한다.
const sanitizeLegacyHtml = (html: string) => {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const allowedTags = new Set(['P','DIV','BR','H1','H2','H3','H4','H5','H6','STRONG','B','EM','I','U','S','DEL','SUP','SUB','UL','OL','LI','BLOCKQUOTE','PRE','CODE','A','IMG','HR','TABLE','THEAD','TBODY','TR','TH','TD','SPAN','SMALL'])
  const removeTags = new Set(['SCRIPT','STYLE','IFRAME','OBJECT','EMBED','FORM','INPUT','BUTTON','SVG','MATH'])
  Array.from(doc.body.querySelectorAll('*')).reverse().forEach(element => {
    if (removeTags.has(element.tagName)) { element.remove(); return }
    if (!allowedTags.has(element.tagName)) { element.replaceWith(...Array.from(element.childNodes)); return }
    Array.from(element.attributes).forEach(attribute => {
      const name = attribute.name.toLowerCase()
      const value = attribute.value
      const allowed = ['href','src','alt','title','width','height','colspan','rowspan','class','data-wikilink-slug','data-spoiler'].includes(name)
      if (!allowed || name.startsWith('on')) { element.removeAttribute(attribute.name); return }
      if (
        (name === 'href' && !/^https?:\/\//i.test(value) && !/^\?term=[A-Za-z0-9%._~-]+$/.test(value)) ||
        (name === 'src' && !safeExternalUrl(value))
      ) element.removeAttribute(attribute.name)
    })
    if (element.tagName === 'A') {
      element.setAttribute('target', '_blank')
      element.setAttribute('rel', 'noopener noreferrer')
      element.setAttribute('style', 'color:#2563eb;text-decoration:underline;cursor:pointer')
      const jiraMatch = element.getAttribute('href')?.match(/\/browse\/([A-Z][A-Z0-9]{1,19}-\d+)$/)
      const jiraTitle = jiraMatch ? JIRA_ISSUE_TITLE_OVERRIDES[jiraMatch[1]] : ''
      if (jiraMatch && jiraTitle && element.textContent?.trim() === jiraMatch[1]) {
        element.textContent = `${jiraMatch[1]}: ${jiraTitle}`
      }
    }
    if (element.tagName === 'IMG') element.setAttribute('style', 'max-width:100%;max-height:450px;border-radius:12px')
    if (element.tagName === 'SPAN' && element.getAttribute('data-spoiler') === 'true') {
      element.setAttribute('style', 'background:#111827;color:#111827;border-radius:3px;padding:0 3px;cursor:pointer')
    }
    if (element.tagName === 'SMALL') {
      element.setAttribute('style', 'display:block;font-size:0.8em;color:#64748b')
    }
  })
  // 기존 HTML 본문에 있던 Jira 이슈 키도 자동 링크 처리한다(코드 블록과 이미 링크된 텍스트는 제외).
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
  const textNodes: Text[] = []
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text)
  const issuePattern = /\b([A-Z][A-Z0-9]{1,19}-\d+)\b/g
  textNodes.forEach(textNode => {
    const parent = textNode.parentElement
    if (!parent || parent.closest('a, code, pre')) return
    const value = textNode.nodeValue || ''
    issuePattern.lastIndex = 0
    if (!issuePattern.test(value)) return
    issuePattern.lastIndex = 0
    const fragment = doc.createDocumentFragment()
    let lastIndex = 0
    for (const match of value.matchAll(issuePattern)) {
      const issueKey = match[1]
      const start = match.index ?? 0
      fragment.append(doc.createTextNode(value.slice(lastIndex, start)))
      const anchor = doc.createElement('a')
      anchor.href = `https://suholab.atlassian.net/browse/${issueKey}`
      anchor.target = '_blank'
      anchor.rel = 'noopener noreferrer'
      anchor.className = 'jira-issue-link'
      const issueTitle = JIRA_ISSUE_TITLE_OVERRIDES[issueKey]
      anchor.textContent = issueTitle ? `${issueKey}: ${issueTitle}` : issueKey
      anchor.setAttribute('style', 'color:#2563eb;text-decoration:underline;font-weight:600')
      fragment.append(anchor)
      lastIndex = start + issueKey.length
    }
    fragment.append(doc.createTextNode(value.slice(lastIndex)))
    textNode.replaceWith(fragment)
  })
  return doc.body.innerHTML
}

const renderDocumentHtml = (content: string, terms: TermDetail[] = []) => {
  if (!content) return '<p class="text-slate-400 italic">작성된 내용이 없습니다.</p>'
  const containsLegacyHtml = /<\/?(p|div|h[1-6]|ul|ol|li|br|img|strong|em|u|del|s|sup|sub|code|small|hr|a|span|table|blockquote|pre)\b/i.test(content)
  return containsLegacyHtml ? sanitizeLegacyHtml(content) : markdownToHtml(content, terms)
}

const getTermPreviewText = (content: string) => {
  if (!content?.trim()) return ''
  const doc = new DOMParser().parseFromString(content, 'text/html')
  return (doc.body.textContent || content)
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, target, alias) => alias || target)
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(new RegExp(String.fromCharCode(96) + '{3}[\\s\\S]*?' + String.fromCharCode(96) + '{3}', 'g'), ' 코드 블록 ')
    .replace(/(\*\*|__|~~|\*|_)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// 상시 가동 중인 Cloudflare Worker 백엔드 주소
const API_BASE_URL = 'https://iot-glossary.smh13918957.workers.dev' 

export default function App() {
  const minimapRef = useRef<SVGSVGElement | null>(null)
  const largeGraphRef = useRef<SVGSVGElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const editorRef = useRef<HTMLDivElement | null>(null)
  const editorRangeRef = useRef<Range | null>(null)
  const graphPositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map())

  const [nodes, setNodes] = useState<Node[]>([])
  const [links, setLinks] = useState<Link[]>([])
  const [allTerms, setAllTerms] = useState<TermDetail[]>([])
  const [selectedTerm, setSelectedTerm] = useState<TermDetail | null>(null)
  
  // 화면 뷰 상태 ('home' | 'list' | 'detail' | 'edit')
  const [currentView, setCurrentView] = useState<'home' | 'list' | 'detail' | 'edit'>('home')
  const [previousView, setPreviousView] = useState<'home' | 'list'>('home')
  
  // 최근 방문 페이지 슬러그 목록 관리 (최대 4개)
  const [recentSlugs, setRecentSlugs] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('iot_recent_slugs')
      return saved ? JSON.parse(saved) : []
    } catch {
      return []
    }
  })
  
  // 신규 문서 작성 중 취소 시 삭제 판별을 위한 플래그
  const [isNewDraft, setIsNewDraft] = useState(false)
  
  // 검색 및 목록 필터 상태 (제목·카테고리·태그 통합 검색)
  const [searchQuery, setSearchQuery] = useState('')
  const [isHomeSearchFocused, setIsHomeSearchFocused] = useState(false)
  const [listSearchQuery, setListSearchQuery] = useState('')
  const [isListSearchFocused, setIsListSearchFocused] = useState(false)
  const [categoryFilter] = useState('all')
  const [selectedListCategories, setSelectedListCategories] = useState<string[]>([])
  const [selectedListTags, setSelectedListTags] = useState<string[]>([])
  
  // 문서 생성 모달 상태
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [isGraphModalOpen, setIsGraphModalOpen] = useState(false)
  const [graphPreviewTerm, setGraphPreviewTerm] = useState<TermDetail | null>(null)
  const [wikiLinkQuery, setWikiLinkQuery] = useState<string | null>(null)
  const [wikiLinkPosition, setWikiLinkPosition] = useState<{ top: number; left: number } | null>(null)
  const [isTestToolsOpen, setIsTestToolsOpen] = useState(false)
  const [testNodeCount, setTestNodeCount] = useState('100')
  const [isTestNodeBusy, setIsTestNodeBusy] = useState(false)
  const [testNodeFeedback, setTestNodeFeedback] = useState('')
  const [linkTestNodeGroups, setLinkTestNodeGroups] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newCategory, setNewCategory] = useState('')
  const [newTagsText, setNewTagsText] = useState('')
  const [createCategorySearch, setCreateCategorySearch] = useState('')
  const [createTagSearch, setCreateTagSearch] = useState('')

  // 문서 편집/작성 상태
  const [editSlug, setEditSlug] = useState('')
  const [editTitle, setEditTitle] = useState('')
  const [editContent, setEditContent] = useState('')
  const [editLinkedSlugs, setEditLinkedSlugs] = useState<string[]>([])
  const [editCategory, setEditCategory] = useState('')
  const [editTagsText, setEditTagsText] = useState('')

  // 문서 설정 변경 모달 상태
  const [isMetaModalOpen, setIsMetaModalOpen] = useState(false)
  const [tempTitle, setTempTitle] = useState('')
  const [tempCategory, setTempCategory] = useState('')
  const [tempTagsText, setTempTagsText] = useState('')
  const [metaTagSearch, setMetaTagSearch] = useState('')

  // 삭제 확인 모달 상태
  const [deleteTargetSlug, setDeleteTargetSlug] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [errorTabMessage, setErrorTabMessage] = useState('')
  const errorTabTimerRef = useRef<number | null>(null)
  const deleteConfirmButtonRef = useRef<HTMLButtonElement | null>(null)

  const categoryColorMap = useMemo(
    () => buildCategoryColorMap(allTerms.map(term => (term.category || '').trim())),
    [allTerms]
  )
  const getCategoryColor = (category?: string | null) => {
    const normalized = (category || '').trim()
    return normalized ? categoryColorMap.get(normalized) || '#64748b' : '#94a3b8'
  }

  const showErrorTab = (message: string) => {
    setErrorTabMessage(message)
    if (errorTabTimerRef.current !== null) window.clearTimeout(errorTabTimerRef.current)
    errorTabTimerRef.current = window.setTimeout(() => setErrorTabMessage(''), 7000)
  }

  useEffect(() => () => {
    if (errorTabTimerRef.current !== null) window.clearTimeout(errorTabTimerRef.current)
  }, [])

  // 삭제 확인 모달이 열리면 삭제 버튼에 포커스를 둔다. 키보드 사용자는 Enter로 확인할 수 있다.
  useEffect(() => {
    if (deleteTargetSlug) deleteConfirmButtonRef.current?.focus()
  }, [deleteTargetSlug])

  // 데이터 로드 및 반지름 동기화
  const fetchData = async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/terms`)
      if (!res.ok) throw new Error(`용어 목록을 불러오지 못했습니다. (${res.status})`)
      const data = await res.json()
      if (data && data.nodes) {
        const normalizedTerms: TermDetail[] = (data.terms || []).map(normalizeTerm)
        const termsBySlug = new Map(normalizedTerms.map(term => [term.slug, term]))
        const rawNodes: Node[] = data.nodes
        const rawLinks: Link[] = data.links || []
        const processedNodes = rawNodes.map(node => {
          const term = termsBySlug.get(node.slug)
          return {
            ...node,
            category: term?.category || node.category || '',
            tags: term ? parseTags(term.tags) : parseTags(node.tags as any),
          }
        })
        setNodes(processedNodes)
        setLinks(rawLinks)
        setAllTerms(normalizedTerms.length ? normalizedTerms : processedNodes.map(normalizeTerm))
      }
    } catch (err) {
      console.error("데이터 로드 실패:", err)
      showErrorTab(err instanceof Error ? err.message : "용어 목록을 불러오지 못했습니다.")
    }
  }

  useEffect(() => {
    fetchData()
  }, [])

  useEffect(() => {
    const slug = new URLSearchParams(window.location.search).get('term')
    if (slug) void fetchTermDetail(slug)
  }, [])

  // 상세 보기 화면에서 Ctrl + Delete 키 입력 시 문서 삭제 단축키 처리
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && (e.key === 'Delete' || e.code === 'Delete')) {
        if (currentView === 'detail' && selectedTerm) {
          e.preventDefault()
          handleDelete(selectedTerm.slug)
        }
      }
    }
    window.addEventListener('keydown', handleGlobalKeyDown)
    return () => window.removeEventListener('keydown', handleGlobalKeyDown)
  }, [currentView, selectedTerm])

  // 편집 화면 진입 시 저장된 Jira 서식 HTML을 편집 가능한 리치 텍스트로 표시한다.
  useEffect(() => {
    if (currentView !== 'edit' || !editorRef.current) return
    const editor = editorRef.current
    editor.textContent = editContent || ''
    editor.focus()
    const selection = window.getSelection()
    if (selection) {
      const range = document.createRange()
      range.selectNodeContents(editor)
      range.collapse(false)
      selection.removeAllRanges()
      selection.addRange(range)
      editorRangeRef.current = range.cloneRange()
    }
  }, [currentView, editSlug, allTerms])

  // 최근 방문 페이지 기록 함수
  const addRecentSlug = (slug: string) => {
    setRecentSlugs(prev => {
      const filtered = prev.filter(s => s !== slug)
      const updated = [slug, ...filtered].slice(0, 4)
      try {
        localStorage.setItem('iot_recent_slugs', JSON.stringify(updated))
      } catch {}
      return updated
    })
  }

  // 특정 용어 상세 조회
  const fetchTermDetail = async (slug: string) => {
    if (currentView !== 'detail' && currentView !== 'edit') {
      setPreviousView(currentView === 'list' ? 'list' : 'home')
    }
    try {
      const res = await fetch(`${API_BASE_URL}/api/terms/${encodeURIComponent(slug)}`)
      if (!res.ok) throw new Error(`문서를 불러오지 못했습니다. (${res.status})`)
      const data = await res.json()
      if (data.term) {
        setSelectedTerm(normalizeTerm(data.term))
        setCurrentView('detail')
        setSearchQuery('')
        setIsHomeSearchFocused(false)
        setIsListSearchFocused(false)
        if (new URLSearchParams(window.location.search).has('term')) {
          window.history.replaceState({}, '', window.location.pathname)
        }
        addRecentSlug(slug)
      }
    } catch (err) {
      console.error("상세 조회 실패:", err)
      showErrorTab(err instanceof Error ? err.message : "문서 상세 정보를 불러오지 못했습니다.")
    }
  }

  const matchesListFilters = (term: TermDetail) => {
    const categoryMatches = selectedListCategories.length === 0 || selectedListCategories.includes(term.category?.trim() || '')
    const tagMatches = selectedListTags.every(tag => parseTags(term.tags).some(item => item.toLocaleLowerCase() === tag.toLocaleLowerCase()))
    const query = listSearchQuery.trim().toLocaleLowerCase()
    const searchable = [term.title, term.slug, term.category || '', ...parseTags(term.tags)].join(' ').toLocaleLowerCase()
    return categoryMatches && tagMatches && (!query || searchable.includes(query))
  }

  // 그래프뷰: 좌표 캐시, 필터 일치 노드만 렌더링하고 노드 수에 따라 시뮬레이션 비용을 조정한다.
  useEffect(() => {
    const graphElement = isGraphModalOpen ? largeGraphRef.current : minimapRef.current
    if (!graphElement) return

    const svg = d3.select(graphElement)
    svg.selectAll('*').remove()
    if (currentView === 'home' || nodes.length === 0) return

    const graphBounds = graphElement.getBoundingClientRect()
    const width = isGraphModalOpen ? Math.max(960, Math.round(graphBounds.width)) : 340
    const height = isGraphModalOpen ? Math.max(680, Math.round(graphBounds.height)) : 340
    if (isGraphModalOpen) graphElement.setAttribute('viewBox', `0 0 ${width} ${height}`)
    else graphElement.removeAttribute('viewBox')
    const activeSlug = selectedTerm?.slug || editSlug
    let relevantNodes = nodes
    let relevantLinks = links

    if ((currentView === 'detail' || currentView === 'edit') && activeSlug) {
      const activeTerm = allTerms.find(term => term.slug === activeSlug)
      const linkedSlugs = new Set(
        currentView === 'edit' && editSlug === activeSlug
          ? editLinkedSlugs
          : activeTerm?.linked_slugs || []
      )
      relevantNodes = nodes.filter(node => node.slug === activeSlug || linkedSlugs.has(node.slug))
      const relevantNodeIds = new Set(relevantNodes.map(node => node.id))
      relevantLinks = links.filter(link => {
        const sourceId = typeof link.source === 'object' ? link.source.id : link.source
        const targetId = typeof link.target === 'object' ? link.target.id : link.target
        return relevantNodeIds.has(sourceId) && relevantNodeIds.has(targetId)
      })
    }
    else if (currentView === 'list') {
      const visibleSlugs = new Set(allTerms.filter(matchesListFilters).map(term => term.slug))
      relevantNodes = nodes.filter(node => visibleSlugs.has(node.slug))
      const visibleIds = new Set(relevantNodes.map(node => node.id))
      relevantLinks = links.filter(link => {
        const sourceId = typeof link.source === 'object' ? link.source.id : link.source
        const targetId = typeof link.target === 'object' ? link.target.id : link.target
        return visibleIds.has(sourceId) && visibleIds.has(targetId)
      })
    }

    if (relevantNodes.length === 0) return

    // React 상태 객체를 D3가 직접 변경하지 않도록 복사하고, 이전 위치는 slug 기준으로 재사용한다.
    const simulationNodes: Node[] = relevantNodes.map(node => {
      const cached = graphPositionsRef.current.get(node.slug)
      return {
        ...node,
        x: cached?.x ?? node.x,
        y: cached?.y ?? node.y,
        vx: 0,
        vy: 0,
        fx: null,
        fy: null
      }
    })
    const simulationLinks: Array<{ source: number | Node; target: number | Node }> = relevantLinks.map(link => ({
      source: typeof link.source === 'object' ? link.source.id : link.source,
      target: typeof link.target === 'object' ? link.target.id : link.target
    }))

    const nodeCount = simulationNodes.length
    const largeGraph = nodeCount > 1200
    const veryLargeGraph = nodeCount > 2500
    if (veryLargeGraph) {
      // 매우 큰 그래프는 충돌 계산을 오래 수행하지 않도록 규칙적인 초기 좌표를 제공한다.
      const columns = Math.ceil(Math.sqrt(nodeCount * (width / Math.max(1, height))))
      const spacing = NODE_RADIUS * 2 + 8
      simulationNodes.forEach((node, index) => {
        if (!Number.isFinite(node.x)) node.x = (index % columns) * spacing
        if (!Number.isFinite(node.y)) node.y = Math.floor(index / columns) * spacing
      })
    }

    const container = svg.append('g')
    const labelThreshold = 160
    const maxLabelCount = nodeCount > 5000 ? 250 : nodeCount > 2500 ? 400 : nodeCount > 1200 ? 600 : nodeCount
    const labelStep = Math.max(1, Math.ceil(nodeCount / Math.max(1, maxLabelCount)))
    const labelableSlugs = new Set(simulationNodes.filter((node, index) => index % labelStep === 0 || node.slug === activeSlug).map(node => node.slug))
    let nodeGroups: any = null
    let allLabelsCreated = nodeCount <= labelThreshold

    const ensureLabels = (includeAll: boolean) => {
      if (!nodeGroups) return
      nodeGroups.each(function(this: SVGGElement, d: Node) {
        if (!includeAll && d.slug !== activeSlug) return
        if (includeAll && !labelableSlugs.has(d.slug)) return
        const group = d3.select(this)
        if (!group.select('text').empty()) return
        group.append('text')
          .text(d.title)
          .attr('x', NODE_RADIUS + 5)
          .attr('y', 4)
          .attr('fill', '#1e293b')
          .attr('font-size', '11px')
          .attr('font-family', '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif')
          .attr('font-weight', 500)
          .style('pointer-events', 'none')
      })
    }

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.05, 4])
      .on('zoom', event => {
        container.attr('transform', event.transform)
        const showLabels = nodeCount <= labelThreshold || event.transform.k >= 1.25
        if (showLabels && !allLabelsCreated) {
          ensureLabels(true)
          allLabelsCreated = true
        }
        nodeGroups?.select('text').style('display', (d: Node) => showLabels || d.slug === activeSlug ? null : 'none')
      })
    svg.call(zoom as any)

    const connectedNodeIds = new Set<number>()
    simulationLinks.forEach(link => {
      connectedNodeIds.add(typeof link.source === 'object' ? link.source.id : link.source)
      connectedNodeIds.add(typeof link.target === 'object' ? link.target.id : link.target)
    })
    const isolatedNodes = simulationNodes.filter(node => !connectedNodeIds.has(node.id))

    // 연결되지 않은 노드가 기존 연결선 위에 놓이지 않도록 선분과의 간격을 확보한다.
    const avoidLinkOverlap = (alpha: number) => {
      if (!isolatedNodes.length || !simulationLinks.length || isolatedNodes.length * simulationLinks.length > 12000) return
      const clearance = NODE_RADIUS * 2 + 8

      isolatedNodes.forEach(node => {
        const nodeX = node.x ?? width / 2
        const nodeY = node.y ?? height / 2
        let pushX = 0
        let pushY = 0

        simulationLinks.forEach((link: any) => {
          const source = link.source as Node
          const target = link.target as Node
          if (!source || !target || typeof source !== 'object' || typeof target !== 'object') return

          const startX = source.x ?? width / 2
          const startY = source.y ?? height / 2
          const segmentX = (target.x ?? width / 2) - startX
          const segmentY = (target.y ?? height / 2) - startY
          const segmentLengthSquared = segmentX * segmentX + segmentY * segmentY
          const projection = segmentLengthSquared > 0
            ? Math.max(0, Math.min(1, ((nodeX - startX) * segmentX + (nodeY - startY) * segmentY) / segmentLengthSquared))
            : 0
          const closestX = startX + projection * segmentX
          const closestY = startY + projection * segmentY
          let offsetX = nodeX - closestX
          let offsetY = nodeY - closestY
          let distance = Math.sqrt(offsetX * offsetX + offsetY * offsetY)

          if (distance >= clearance) return
          if (distance < 0.001) {
            const angle = ((node.id * 37 + (source.id + target.id) * 13) % 360) * Math.PI / 180
            offsetX = Math.cos(angle)
            offsetY = Math.sin(angle)
            distance = 1
          }

          const strength = (clearance - distance) * alpha * 0.16
          pushX += (offsetX / distance) * strength
          pushY += (offsetY / distance) * strength
        })

        node.vx = (node.vx ?? 0) + pushX
        node.vy = (node.vy ?? 0) + pushY
      })
    }

    const simulation = d3.forceSimulation(simulationNodes as d3.SimulationNodeDatum[])
      .alpha(largeGraph ? 0.45 : 0.75)
      .alphaDecay(largeGraph ? 0.14 : 0.085)
      .velocityDecay(0.5)
      .force('link', d3.forceLink(simulationLinks as any).id((d: any) => d.id).distance(largeGraph ? 76 : 100).iterations(1))
      .force('charge', d3.forceManyBody().strength(largeGraph ? -95 : -175).distanceMax(largeGraph ? 150 : 260).theta(largeGraph ? 1.1 : 0.9))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collide', d3.forceCollide().radius(NODE_RADIUS + (largeGraph ? 5 : 13)).iterations(1))
      .force('avoid-links', nodeCount <= 300 ? avoidLinkOverlap as any : null)

    const linkSelection = container.append('g')
      .attr('stroke', '#cbd5e1')
      .attr('stroke-opacity', 0.8)
      .attr('stroke-width', 1.35)
      .selectAll('line')
      .data(simulationLinks)
      .join('line')

    nodeGroups = container.append('g')
      .selectAll<SVGGElement, Node>('g')
      .data(simulationNodes)
      .join('g')
      .attr('class', 'graph-node')
      .style('cursor', 'grab')
      .call(d3.drag<SVGGElement, Node>()
        .on('start', (event, d) => {
          if (!event.active) simulation.alphaTarget(0.22).restart()
          d.fx = d.x ?? 0
          d.fy = d.y ?? 0
          d3.select(event.sourceEvent.target.closest('g') || event.sourceEvent.target.parentNode).raise()
        })
        .on('drag', (event, d) => {
          d.fx = event.x
          d.fy = event.y
        })
        .on('end', (event, d) => {
          if (!event.active) simulation.alphaTarget(0)
          d.fx = null
          d.fy = null
          if (typeof d.x === 'number' && typeof d.y === 'number') graphPositionsRef.current.set(d.slug, { x: d.x, y: d.y })
        })
      )

    nodeGroups.append('circle')
      .attr('r', NODE_RADIUS)
      .attr('fill', (d: Node) => getCategoryColor(d.category))
      .attr('stroke', (d: Node) => d.slug === activeSlug ? '#94a3b8' : '#ffffff')
      .attr('stroke-width', (d: Node) => d.slug === activeSlug ? 2.25 : 1.75)
      .append('title')
      .text((d: Node) => `${d.title} · ${d.category || '카테고리 없음'}`)

    ensureLabels(nodeCount <= labelThreshold)

    nodeGroups.on('click', (event: any, d: Node) => {
      event.stopPropagation()
      if (isGraphModalOpen) {
        const existingTerm = allTerms.find(term => term.slug === d.slug)
        setGraphPreviewTerm(existingTerm || {
          id: d.id,
          slug: d.slug,
          title: d.title,
          content: '',
          parent_slug: d.parent_slug,
          linked_slugs: d.linked_slugs || [],
          category: d.category || '',
          tags: parseTags(d.tags),
          updated_at: ''
        })
        return
      }
      void fetchTermDetail(d.slug)
    })

    const fitView = () => {
      const positioned = simulationNodes.filter(node => Number.isFinite(node.x) && Number.isFinite(node.y))
      if (!positioned.length) return
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
      positioned.forEach(node => {
        x0 = Math.min(x0, node.x as number)
        x1 = Math.max(x1, node.x as number)
        y0 = Math.min(y0, node.y as number)
        y1 = Math.max(y1, node.y as number)
      })
      const boundsWidth = Math.max(1, x1 - x0)
      const boundsHeight = Math.max(1, y1 - y0)
      const padding = NODE_RADIUS * 2 + 12
      const availableWidth = Math.max(1, width - padding * 2)
      const availableHeight = Math.max(1, height - padding * 2)
      const scale = Math.min(1.2, Math.max(0.05, 0.9 / Math.max(boundsWidth / availableWidth, boundsHeight / availableHeight)))
      const midX = (x0 + x1) / 2
      const midY = (y0 + y1) / 2
      svg.call(zoom.transform as any, d3.zoomIdentity
        .translate(width / 2 - scale * midX, height / 2 - scale * midY)
        .scale(scale))
    }

    const renderGraphPositions = () => {
      linkSelection
        .attr('x1', (d: any) => d.source.x)
        .attr('y1', (d: any) => d.source.y)
        .attr('x2', (d: any) => d.target.x)
        .attr('y2', (d: any) => d.target.y)
      nodeGroups.attr('transform', (d: Node) => `translate(${d.x ?? width / 2}, ${d.y ?? height / 2})`)
    }

    simulation.on('tick', renderGraphPositions)
    simulation.on('end', () => {
      simulationNodes.forEach(node => {
        if (typeof node.x === 'number' && typeof node.y === 'number') {
          graphPositionsRef.current.set(node.slug, { x: node.x, y: node.y })
        }
      })
    })

    // 화면을 전환한 직후 초기 배치와 전체 화면 맞춤을 끝내고, 뒤늦은 자동 확대 변경을 방지한다.
    simulation.stop()
    const initialTicks = nodeCount > 5000 ? 0 : nodeCount > 2500 ? 6 : nodeCount > 1200 ? 24 : nodeCount > 300 ? 48 : 120
    simulation.tick(initialTicks)
    renderGraphPositions()
    fitView()

    return () => {
      simulation.stop()
      simulationNodes.forEach(node => {
        if (typeof node.x === 'number' && typeof node.y === 'number') {
          graphPositionsRef.current.set(node.slug, { x: node.x, y: node.y })
        }
      })
      svg.on('.zoom', null)
      svg.selectAll('*').remove()
    }
  }, [nodes, links, currentView, selectedTerm?.slug, editSlug, editLinkedSlugs, allTerms, categoryColorMap, categoryFilter, selectedListCategories, selectedListTags, listSearchQuery, isGraphModalOpen])

  // 내용 작성 탭 진입 시점에 정식 노드 생성
  const handleProceedToEdit = async (e?: React.FormEvent, titleOverride?: string, categoryOverride?: string, tagsOverride?: string) => {
    if (e) e.preventDefault()
    const titleToUse = (titleOverride ?? newTitle).trim()
    if (!titleToUse) {
      showErrorTab('문서 제목을 입력해주세요.')
      return
    }

    let baseSlug = titleToUse.toLowerCase().replace(/[^a-z0-9가-힣]+/g, '-')
    if (!baseSlug || baseSlug === '-') {
      baseSlug = 'term'
    }
    const slug = baseSlug + '-' + Date.now()

    try {
      const res = await fetch(`${API_BASE_URL}/api/terms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: slug,
          title: titleToUse,
          content: '', 
          category: (categoryOverride ?? newCategory).trim() || null,
          tags: parseTags(tagsOverride ?? newTagsText),
          linked_slugs: []
        })
      })

      if (res.ok) {

        setIsModalOpen(false)
        setIsNewDraft(true)
        await fetchData()
        
        const detailRes = await fetch(`${API_BASE_URL}/api/terms/${encodeURIComponent(slug)}`)
        if (!detailRes.ok) throw new Error(`생성한 문서를 불러오지 못했습니다. (${detailRes.status})`)
        const detailData = await detailRes.json()
        if (detailData.term) {
          const term = normalizeTerm(detailData.term)
          setSelectedTerm(term)
          setEditSlug(term.slug)
          setEditTitle(term.title)
          setEditContent(term.content)
          setEditLinkedSlugs(term.linked_slugs || [])
          setEditCategory(term.category || '')
          setEditTagsText(parseTags(term.tags).join(', '))
          setCurrentView('edit')
        }
      } else {
        const errData = await res.json().catch(() => ({}))
        showErrorTab("문서 생성에 실패했습니다: " + (errData.error || res.statusText))
      }
    } catch (err) {
      console.error("생성 에러:", err)
      showErrorTab(err instanceof Error ? err.message : "서버 통신 중 오류가 발생했습니다.")
    }
  }

  // 문서 저장
  const handleSaveEdit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault()

    try {
      const content = editorRef.current?.innerText ?? editContent
      const linkedSlugs = extractWikiLinkedSlugs(content, allTerms, editSlug)
      const res = await fetch(`${API_BASE_URL}/api/terms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: editSlug,
          title: editTitle,
          content,
          category: editCategory.trim() || null,
          tags: parseTags(editTagsText),
          linked_slugs: linkedSlugs
        })
      })

      if (res.ok) {
        setEditLinkedSlugs(linkedSlugs)
        setIsNewDraft(false)
        await fetchData()
        await fetchTermDetail(editSlug)
        return true
      } else {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `저장에 실패했습니다. (${res.status})`)
      }
    } catch (err) {
      console.error("저장 에러:", err)
      showErrorTab(err instanceof Error ? err.message : "문서 저장 중 오류가 발생했습니다.")
      return false
    }
  }

  // 작성 중 취소 처리
  const handleCancelEdit = async () => {
    if (isNewDraft) {
      try {
        const deleteRes = await fetch(`${API_BASE_URL}/api/terms/${encodeURIComponent(editSlug)}`, { method: 'DELETE' })
        if (!deleteRes.ok) throw new Error(`임시 문서 삭제에 실패했습니다. (${deleteRes.status})`)
        await fetchData()
      } catch (err) {
        console.error("임시 문서 삭제 실패:", err)
        showErrorTab(err instanceof Error ? err.message : "임시 문서 삭제에 실패했습니다.")
      }
      setIsNewDraft(false)
      setSelectedTerm(null)
      setCurrentView(previousView)
    } else {
      fetchTermDetail(editSlug)
    }
  }

  // 삭제 버튼을 누르면 브라우저 알림 대신 앱 내부 확인 모달을 연다.
  const handleDelete = (slug: string) => {
    setDeleteTargetSlug(slug)
    setDeleteError('')
  }

  const confirmDelete = async () => {
    if (!deleteTargetSlug || isDeleting) return
    setIsDeleting(true)
    setDeleteError('')
    try {
      const res = await fetch(`${API_BASE_URL}/api/terms/${encodeURIComponent(deleteTargetSlug)}`, {
        method: 'DELETE'
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `삭제에 실패했습니다. (${res.status})`)
      }
      await fetchData()
      setDeleteTargetSlug(null)
      setSelectedTerm(null)
      setCurrentView(previousView)
    } catch (err) {
      console.error("삭제 에러:", err)
      const message = err instanceof Error ? err.message : '삭제 중 오류가 발생했습니다.'
      setDeleteError(message)
      showErrorTab(message)
    } finally {
      setIsDeleting(false)
    }
  }

  const handleGenerateTestNodes = async () => {
    const count = Number(testNodeCount)
    if (!Number.isInteger(count) || count < 1 || count > 10000) {
      showErrorTab('테스트 노드 생성 개수는 1~10,000 사이의 정수로 입력해주세요.')
      return
    }
    setIsTestNodeBusy(true)
    setTestNodeFeedback('')
    try {
      const response = await fetch(`${API_BASE_URL}/api/test-nodes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count, linkGroups: linkTestNodeGroups, groupSize: 20 })
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || `테스트 노드 생성에 실패했습니다. (${response.status})`)
      await fetchData()
      setTestNodeFeedback(linkTestNodeGroups
        ? `테스트 노드 ${data.created ?? count}개를 ${data.linked_groups ?? Math.ceil(count / 20)}개 그룹으로 연결했습니다. (그룹당 최대 20개)`
        : `테스트 노드 ${data.created ?? count}개를 생성했습니다.`)
    } catch (error) {
      const message = error instanceof Error ? error.message : '테스트 노드 생성에 실패했습니다.'
      setTestNodeFeedback(message)
      showErrorTab(message)
    } finally {
      setIsTestNodeBusy(false)
    }
  }

  const handleDeleteTestNodes = async () => {
    if (!window.confirm('자동 생성한 테스트 노드를 모두 삭제할까요? 일반 문서는 삭제되지 않습니다.')) return
    setIsTestNodeBusy(true)
    setTestNodeFeedback('')
    try {
      const response = await fetch(`${API_BASE_URL}/api/test-nodes`, { method: 'DELETE' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || `테스트 노드 정리에 실패했습니다. (${response.status})`)
      await fetchData()
      setTestNodeFeedback(`테스트 노드 ${data.deleted ?? 0}개를 삭제했습니다.`)
    } catch (error) {
      const message = error instanceof Error ? error.message : '테스트 노드 정리에 실패했습니다.'
      setTestNodeFeedback(message)
      showErrorTab(message)
    } finally {
      setIsTestNodeBusy(false)
    }
  }

  // 수정 모드 진입
  const openEditView = () => {
    if (!selectedTerm) return
    setIsNewDraft(false)
    setEditSlug(selectedTerm.slug)
    setEditTitle(selectedTerm.title)
    setEditContent(selectedTerm.content)
    setEditLinkedSlugs(selectedTerm.linked_slugs || [])
    setEditCategory(selectedTerm.category || '')
    setEditTagsText(parseTags(selectedTerm.tags).join(', '))
    setCurrentView('edit')
  }

  // 새 문서 모달 열기
  const openCreateModal = () => {
    setNewTitle('')
    setNewCategory('')
    setNewTagsText('')
    setCreateCategorySearch('')
    setCreateTagSearch('')
    setIsModalOpen(true)
  }

  // Ctrl+N은 현재 편집 내용을 먼저 저장한 뒤 새 문서 편집 화면을 바로 연다.
  useEffect(() => {
    const handleNewDocumentShortcut = async (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'n' || event.altKey || event.shiftKey) return
      if (isModalOpen || isTestToolsOpen) return
      event.preventDefault()
      if (currentView === 'edit') {
        const saved = await handleSaveEdit()
        if (!saved) return
      }
      setNewCategory('')
      setNewTagsText('')
      setCreateCategorySearch('')
      setCreateTagSearch('')
      await handleProceedToEdit(undefined, '새 문서', '', '')
    }
    window.addEventListener('keydown', handleNewDocumentShortcut)
    return () => window.removeEventListener('keydown', handleNewDocumentShortcut)
  }, [currentView, isModalOpen, isTestToolsOpen, editSlug, editTitle, editContent, editCategory, editTagsText, editLinkedSlugs, allTerms])

  // 편집기 커서/선택 영역을 기억해 이미지 업로드 이후에도 삽입 위치를 유지한다.
  const rememberEditorSelection = () => {
    const editor = editorRef.current
    const selection = window.getSelection()
    if (!editor || !selection || selection.rangeCount === 0) return
    const range = selection.getRangeAt(0)
    if (editor.contains(range.commonAncestorContainer)) editorRangeRef.current = range.cloneRange()
  }

  const updateEditorContent = () => {
    if (editorRef.current) setEditContent(editorRef.current.innerHTML)
    rememberEditorSelection()
  }

  const insertNodeAtEditorCursor = (node: globalThis.Node) => {
    const editor = editorRef.current
    if (!editor) return
    editor.focus()
    const selection = window.getSelection()
    let range = editorRangeRef.current?.cloneRange() || (selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null)
    if (!range || !editor.contains(range.commonAncestorContainer)) {
      range = document.createRange()
      range.selectNodeContents(editor)
      range.collapse(false)
    }
    range.deleteContents()
    const lastInsertedNode = node.nodeType === 11 ? node.lastChild : node
    range.insertNode(node)
    if (lastInsertedNode && lastInsertedNode.parentNode) range.setStartAfter(lastInsertedNode)
    else range.selectNodeContents(editor)
    range.collapse(true)
    selection?.removeAllRanges()
    selection?.addRange(range)
    editorRangeRef.current = range.cloneRange()
    setEditContent(editor.innerHTML)
  }

  const insertPlainTextAtEditorCursor = (value: string) => {
    const fragment = document.createDocumentFragment()
    const parts = value.replace(/\r\n?/g, '\n').split('\n')
    parts.forEach((part, index) => {
      if (index > 0) fragment.append(document.createElement('br'))
      if (part) fragment.append(document.createTextNode(part))
    })
    insertNodeAtEditorCursor(fragment)
  }


  // 편집 중에는 위키 링크 자동완성에 필요한 텍스트 범위만 바꾼다.
  const replaceEditorTextToken = (
    textNode: Text,
    startOffset: number,
    endOffset: number,
    node: globalThis.Node
  ) => {
    const editor = editorRef.current
    const parent = textNode.parentNode
    if (!editor || !parent) return false
    const value = textNode.nodeValue || ''
    const prefix = value.slice(0, startOffset)
    const suffix = value.slice(endOffset)
    const fragment = document.createDocumentFragment()
    if (prefix) fragment.append(document.createTextNode(prefix))
    fragment.append(node)
    const suffixNode = suffix ? document.createTextNode(suffix) : null
    if (suffixNode) fragment.append(suffixNode)
    parent.replaceChild(fragment, textNode)

    const selection = window.getSelection()
    if (selection) {
      const range = document.createRange()
      if (suffixNode) range.setStart(suffixNode, 0)
      else range.setStartAfter(node)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
      editorRangeRef.current = range.cloneRange()
    }
    setEditContent(editor.innerText)
    return true
  }

  const updateWikiLinkQueryAtCaret = () => {
    const editor = editorRef.current
    const selection = window.getSelection()
    if (!editor || !selection || selection.rangeCount === 0 || !selection.isCollapsed) {
      setWikiLinkQuery(null)
      setWikiLinkPosition(null)
      return
    }
    const range = selection.getRangeAt(0)
    if (range.startContainer.nodeType !== 3 || !editor.contains(range.startContainer)) {
      setWikiLinkQuery(null)
      setWikiLinkPosition(null)
      return
    }
    const textNode = range.startContainer as Text
    const before = (textNode.nodeValue || '').slice(0, range.startOffset)
    const openIndex = before.lastIndexOf('[[')
    if (openIndex < 0 || before.slice(openIndex + 2).includes(']]')) {
      setWikiLinkQuery(null)
      setWikiLinkPosition(null)
      return
    }
    const caretRect = range.getBoundingClientRect()
    const dropdownWidth = Math.min(360, window.innerWidth - 24)
    const dropdownHeight = 220
    const left = Math.max(12, Math.min(caretRect.left, window.innerWidth - dropdownWidth - 12))
    const top = window.innerHeight - caretRect.bottom > dropdownHeight + 16
      ? caretRect.bottom + 8
      : Math.max(12, caretRect.top - dropdownHeight - 8)
    setWikiLinkPosition({ top, left })
    setWikiLinkQuery(before.slice(openIndex + 2))
  }

  const insertWikiLinkSuggestion = (term: TermDetail) => {
    const editor = editorRef.current
    const selection = window.getSelection()
    if (!editor || !selection || selection.rangeCount === 0 || !selection.isCollapsed) return
    const range = selection.getRangeAt(0)
    if (range.startContainer.nodeType !== 3) return
    const textNode = range.startContainer as Text
    const before = (textNode.nodeValue || '').slice(0, range.startOffset)
    const openIndex = before.lastIndexOf('[[')
    if (openIndex < 0) return
    replaceEditorTextToken(textNode, openIndex, range.startOffset, document.createTextNode(`[[${term.title}]]`))
    setWikiLinkQuery(null)
    setWikiLinkPosition(null)
  }

  const handleEditorInput = (event: React.FormEvent<HTMLDivElement>) => {
    updateEditorContent()
    const nativeEvent = event.nativeEvent as InputEvent
    if (nativeEvent.isComposing) return
    updateWikiLinkQueryAtCaret()
  }

  const handleEditorKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault()
      handleSaveEdit()
    }
  }

  // 이미지 업로드는 현재 커서 위치에 이미지 요소로 직접 삽입한다.
  const insertImageFile = (file: File, altText: string) => {
    if (!file.type.startsWith('image/')) {
      showErrorTab('이미지 파일만 업로드할 수 있습니다.')
      return
    }
    const reader = new FileReader()
    reader.onload = event => {
      const dataUrl = event.target?.result as string
      const image = document.createElement('img')
      image.src = dataUrl
      image.alt = altText
      image.style.maxWidth = '100%'
      image.style.maxHeight = '450px'
      image.style.borderRadius = '12px'
      insertNodeAtEditorCursor(image)
    }
    reader.onerror = () => showErrorTab('이미지를 읽지 못했습니다.')
    reader.readAsDataURL(file)
  }

  const handleImageUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) insertImageFile(file, file.name)
    event.target.value = ''
  }

  const handlePaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    const imageItem = Array.from(event.clipboardData.items).find(item => item.type.startsWith('image/'))
    if (imageItem) {
      const file = imageItem.getAsFile()
      if (!file) return
      event.preventDefault()
      insertImageFile(file, '붙여넣은 이미지')
      return
    }
    // 외부 HTML이 에디터에 그대로 삽입되지 않도록 일반 텍스트만 붙여넣는다.
    event.preventDefault()
    insertPlainTextAtEditorCursor(event.clipboardData.getData('text/plain'))
  }



  // 작성/수정 페이지 단축키 (Ctrl + Enter) 핸들러
  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.defaultPrevented) return
    if (e.ctrlKey && e.key === 'Enter') {
      e.preventDefault()
      handleSaveEdit()
    }
  }

  const normalizedSearch = searchQuery.trim().toLocaleLowerCase()
  const filteredTerms = normalizedSearch
    ? allTerms.filter(term => {
        const searchable = [term.title, term.slug, term.category || '', ...parseTags(term.tags)]
          .join(' ')
          .toLocaleLowerCase()
        return searchable.includes(normalizedSearch)
      })
    : []

  const categories = [...new Set(allTerms.map(term => (term.category || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'))

  const tagSuggestionStats = useMemo(() => {
    const stats = new Map<string, { count: number; categories: Map<string, number> }>()
    allTerms.forEach(term => {
      const category = (term.category || '').trim()
      parseTags(term.tags).forEach(tag => {
        const current = stats.get(tag) || { count: 0, categories: new Map<string, number>() }
        current.count++
        if (category) current.categories.set(category, (current.categories.get(category) || 0) + 1)
        stats.set(tag, current)
      })
    })
    return stats
  }, [allTerms])

  const getTagSuggestions = (category: string, query: string, selectedTags: string[]) => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    const selected = new Set(selectedTags.map(tag => tag.toLocaleLowerCase()))
    return [...tagSuggestionStats.entries()]
      .filter(([tag]) => !selected.has(tag.toLocaleLowerCase()) && (!normalizedQuery || tag.toLocaleLowerCase().includes(normalizedQuery)))
      .sort((a, b) => {
        const categoryA = a[1].categories.get(category) || 0
        const categoryB = b[1].categories.get(category) || 0
        return categoryB - categoryA || b[1].count - a[1].count || a[0].localeCompare(b[0], 'ko')
      })
      .slice(0, 10)
      .map(([tag]) => tag)
  }

  const appendTag = (current: string, tag: string) => {
    const values = parseTags(current)
    if (!values.some(value => value.toLocaleLowerCase() === tag.toLocaleLowerCase())) values.push(tag)
    return values.join(', ')
  }

  const categorySuggestionStats = useMemo(() => {
    const stats = new Map<string, number>()
    allTerms.forEach(term => {
      const category = (term.category || '').trim()
      if (category) stats.set(category, (stats.get(category) || 0) + 1)
    })
    return stats
  }, [allTerms])

  const createSelectedTags = parseTags(newTagsText)
  const metaSelectedTags = parseTags(tempTagsText)
  const normalizedCreateCategorySearch = createCategorySearch.trim().toLocaleLowerCase()
  const normalizedCreateTagSearch = createTagSearch.trim().toLocaleLowerCase()
  const createCategoryChoices = categories
    .filter(category => !normalizedCreateCategorySearch || category.toLocaleLowerCase().includes(normalizedCreateCategorySearch))
    .sort((a, b) => (categorySuggestionStats.get(b) || 0) - (categorySuggestionStats.get(a) || 0) || a.localeCompare(b, 'ko'))
    .slice(0, 8)
  const createTagChoices = getTagSuggestions(newCategory, createTagSearch, createSelectedTags)
  const createCategoryCanBeAdded = Boolean(createCategorySearch.trim()) &&
    !categories.some(category => category.toLocaleLowerCase() === normalizedCreateCategorySearch)
  const createTagCanBeAdded = Boolean(createTagSearch.trim()) &&
    ![...tagSuggestionStats.keys()].some(tag => tag.toLocaleLowerCase() === normalizedCreateTagSearch) &&
    !createSelectedTags.some(tag => tag.toLocaleLowerCase() === normalizedCreateTagSearch)

  const addCreateCategory = (category: string) => {
    const value = category.trim()
    if (!value) return
    const existing = categories.find(item => item.toLocaleLowerCase() === value.toLocaleLowerCase())
    setNewCategory(existing || value)
    setCreateCategorySearch('')
  }

  const addCreateTag = (tag: string) => {
    const value = tag.trim().replace(/^#+/, '')
    if (!value) return
    setNewTagsText(current => appendTag(current, value))
    setCreateTagSearch('')
  }
  const metaTagChoices = getTagSuggestions(tempCategory, metaTagSearch, metaSelectedTags)
  const activeGraphSlug = currentView === 'edit' ? editSlug : selectedTerm?.slug || ''
  const activeGraphLinks = currentView === 'edit'
    ? editLinkedSlugs
    : allTerms.find(term => term.slug === activeGraphSlug)?.linked_slugs || []
  const normalizedListSearch = listSearchQuery.trim().toLocaleLowerCase()
  const listCategoryOptions = [...new Set(allTerms.map(term => term.category?.trim() || '').filter((category, index, arr) => arr.indexOf(category) === index))].sort((a,b)=>a.localeCompare(b,'ko'))
  const listTagOptions = [...new Set(allTerms.flatMap(term => parseTags(term.tags)))].sort((a,b)=>a.localeCompare(b,'ko'))
  const listFilterSuggestions = [...listCategoryOptions.map(value => ({type:'category' as const,value})), ...listTagOptions.map(value => ({type:'tag' as const,value}))]
    .filter(item => !normalizedListSearch || item.value.toLocaleLowerCase().includes(normalizedListSearch))
    .filter(item => item.type === 'category' ? !selectedListCategories.includes(item.value) : !selectedListTags.includes(item.value))
    .slice(0,12)
  const filteredListTerms = allTerms.filter(matchesListFilters)
  const filteredListSlugs = new Set(filteredListTerms.map(term => term.slug))
  const graphDisplayNodes = (currentView === 'detail' || currentView === 'edit') && activeGraphSlug
    ? nodes.filter(node => node.slug === activeGraphSlug || activeGraphLinks.includes(node.slug))
    : currentView === 'list'
      ? nodes.filter(node => filteredListSlugs.has(node.slug))
      : nodes
  const graphCategories = [...new Set(graphDisplayNodes.map(node => (node.category || '').trim()))].sort((a, b) => a.localeCompare(b, 'ko'))

  return (
    <div className="flex flex-col w-screen h-screen bg-slate-100 font-sans overflow-hidden">
      {/* 상단 네비게이션바 */}
      <header className="flex justify-between items-center px-8 py-4 bg-white border-b border-slate-200 shadow-sm shrink-0">
        <h1 
          onClick={() => { setCurrentView('home'); setSearchQuery(''); }} 
          className="text-xl font-extrabold text-blue-600 cursor-pointer"
        >
          IoT Glossary
        </h1>
        <div className="flex items-center gap-4">
          <button
            onClick={() => { setCurrentView('list'); setSearchQuery(''); }}
            className="text-sm font-bold text-slate-600 hover:text-blue-600 transition"
          >
            모든 문서 보기
          </button>
          <button
            onClick={() => { setTestNodeFeedback(''); setIsTestToolsOpen(true) }}
            className="text-sm font-bold text-slate-600 hover:text-violet-700 transition"
          >
            성능 테스트
          </button>
          <button
            onClick={openCreateModal}
            className="bg-blue-600 text-white px-4 py-2 rounded-xl text-sm font-bold shadow-md hover:bg-blue-700 transition"
          >
            새 문서 생성
          </button>
        </div>
      </header>

      {errorTabMessage && (
        <div className="fixed top-20 right-5 z-[100] w-[min(420px,calc(100vw-2.5rem))] rounded-xl border border-rose-300 bg-white shadow-xl" role="alert" aria-live="assertive">
          <div className="flex items-start gap-3 p-4">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-rose-100 text-rose-700 font-bold">!</span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-rose-800">작업 중 오류가 발생했습니다.</p>
              <p className="mt-1 break-words text-sm text-slate-700">{errorTabMessage}</p>
            </div>
            <button type="button" onClick={() => setErrorTabMessage('')} className="text-slate-400 hover:text-slate-700" aria-label="오류 알림 닫기">×</button>
          </div>
        </div>
      )}

      {/* 메인 콘텐츠 영역 */}
      <main className="flex-1 overflow-y-auto p-8 relative flex items-start justify-center">
        {currentView === 'home' && (
          <div className="w-full max-w-xl flex flex-col items-center justify-center gap-6 text-center relative mt-20">
            <div className="flex flex-col gap-2">
              <h2 className="text-3xl font-black text-slate-800">IoT 지식 용어 사전</h2>
              <p className="text-sm text-slate-500">원하는 문서의 제목을 검색해 보세요.</p>
            </div>
            
            <div className="w-full relative">
              <input
                type="text"
                placeholder="검색할 문서 제목을 입력하세요..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onFocus={() => setIsHomeSearchFocused(true)}
                onBlur={() => setIsHomeSearchFocused(false)}
                className="w-full bg-white border border-slate-400 rounded-xl px-4 py-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />

              {isHomeSearchFocused && filteredTerms.length > 0 && (
                <div className="absolute left-0 right-0 top-full mt-2 bg-white border border-slate-300 rounded-xl shadow-xl max-h-60 overflow-y-auto z-20 text-left">
                  {filteredTerms.map((term) => (
                    <div
                      key={term.slug}
                      onMouseDown={event => event.preventDefault()}
                      onClick={() => { setIsHomeSearchFocused(false); void fetchTermDetail(term.slug) }}
                      className="p-3 hover:bg-blue-50 cursor-pointer border-b border-slate-100 last:border-none transition flex justify-between items-center"
                    >
                      <div className="min-w-0">
                        <span className="block font-bold text-slate-800 text-sm">{term.title}</span>
                        {(term.category || parseTags(term.tags).length > 0) && (
                          <span className="block text-[11px] text-slate-400 truncate">{[term.category, ...parseTags(term.tags).map(tag => `#${tag}`)].filter(Boolean).join(' · ')}</span>
                        )}
                      </div>
                      <span className="text-xs text-slate-400 font-mono shrink-0">{term.slug}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 아래 최근 방문 페이지 4개 목록 영역 */}
            <div className="w-full flex flex-col gap-3 text-left mt-2">
              <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">최근 방문 페이지</span>
              <div className="grid grid-cols-2 gap-3">
                {recentSlugs.map((slug) => {
                  const term = allTerms.find(t => t.slug === slug)
                  if (!term) return null
                  return (
                    <div
                      key={slug}
                      onClick={() => fetchTermDetail(slug)}
                      className="p-3 bg-white border border-slate-300 rounded-xl hover:bg-blue-50 cursor-pointer transition flex justify-between items-center shadow-sm"
                    >
                      <div className="min-w-0">
                        <span className="block font-bold text-slate-800 text-sm truncate">{term.title}</span>
                        <span className="block text-[11px] text-slate-400 truncate">{term.category || '카테고리 없음'}</span>
                      </div>
                      <span className="text-xs text-blue-600 font-bold shrink-0 ml-2">열기 &rarr;</span>
                    </div>
                  )
                })}
              </div>
              {recentSlugs.length === 0 && (
                <div className="p-4 bg-white border border-slate-300 rounded-xl text-center text-xs text-slate-400 italic shadow-sm">
                  최근 방문한 페이지가 없습니다.
                </div>
              )}
            </div>
          </div>
        )}

        {currentView === 'list' && (
          <div className="w-full max-w-7xl flex gap-8 items-start justify-center">
            {/* 모든 문서 목록 박스 */}
            <div className="flex-1 bg-white p-8 rounded-2xl shadow-sm border border-slate-200 flex flex-col min-h-[750px]">
              <div className="flex justify-between items-center border-b pb-4 mb-6">
                <h2 className="text-2xl font-black text-slate-800">전체 문서 목록</h2>
                <button
                  onClick={() => setCurrentView('home')}
                  className="text-sm bg-slate-100 text-slate-700 font-bold px-4 py-2 rounded-xl hover:bg-slate-200 transition"
                >
                  홈으로 돌아가기
                </button>
              </div>
              <div className="mb-4 flex flex-col gap-3">
                <div className="relative">
                  <input
                    value={listSearchQuery}
                    onChange={e => setListSearchQuery(e.target.value)}
                    onFocus={() => setIsListSearchFocused(true)}
                    onBlur={() => setIsListSearchFocused(false)}
                    placeholder="제목·카테고리·태그 검색 또는 필터 선택..."
                    className="w-full bg-white border border-slate-300 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  {isListSearchFocused && listFilterSuggestions.length > 0 && (
                    <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-48 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg">
                      {listFilterSuggestions.map(item => (
                        <button
                          key={item.type + item.value}
                          type="button"
                          onMouseDown={event => event.preventDefault()}
                          onClick={() => {
                            item.type === 'category'
                              ? setSelectedListCategories(values => values.includes(item.value) ? values : [...values, item.value])
                              : setSelectedListTags(values => values.includes(item.value) ? values : [...values, item.value])
                          }}
                          className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-blue-50"
                        >
                          <span>{item.value || '카테고리 없음'}</span>
                          <span className="text-[10px] text-slate-400">{item.type === 'category' ? '카테고리' : '태그'}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {(selectedListCategories.length>0||selectedListTags.length>0)&&<div className="flex flex-wrap gap-2">
                  {selectedListCategories.map(category=><button key={'c'+category} onClick={()=>setSelectedListCategories(v=>v.filter(x=>x!==category))} className="rounded-full bg-blue-50 px-3 py-1 text-xs text-blue-700">카테고리: {category||'없음'} ×</button>)}
                  {selectedListTags.map(tag=><button key={'t'+tag} onClick={()=>setSelectedListTags(v=>v.filter(x=>x!==tag))} className="rounded-full bg-violet-50 px-3 py-1 text-xs text-violet-700">태그: {tag} ×</button>)}
                </div>}
              </div>
              <div className="flex items-center justify-between mb-3 text-xs text-slate-400">
                <span>총 {filteredListTerms.length}개 문서</span>
                {(selectedListCategories.length>0||selectedListTags.length>0||listSearchQuery)&&<button onClick={()=>{setSelectedListCategories([]);setSelectedListTags([]);setListSearchQuery('')}} className="font-semibold text-blue-600 hover:underline">필터 초기화</button>}
              </div>
              <div className="flex flex-col gap-3">
                {filteredListTerms.map((term) => (
                  <div
                    key={term.id || term.slug}
                    onClick={() => fetchTermDetail(term.slug)}
                    className="p-4 bg-slate-50 hover:bg-blue-50 border border-slate-300 rounded-xl cursor-pointer transition flex justify-between items-center gap-4"
                  >
                    <div className="min-w-0">
                      <h3 className="font-bold text-slate-800 text-lg truncate">{term.title}</h3>
                      <span className="text-xs text-slate-400 font-mono">slug: {term.slug}</span>
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {term.category && <span className="text-[11px] bg-blue-100 text-blue-700 px-2 py-0.5 rounded-md">{term.category}</span>}
                        {parseTags(term.tags).map(tag => <span key={tag} className="text-[11px] bg-slate-200 text-slate-600 px-2 py-0.5 rounded-md">#{tag}</span>)}
                      </div>
                    </div>
                    <span className="text-xs text-blue-600 font-bold shrink-0">읽기 &rarr;</span>
                  </div>
                ))}
                {filteredListTerms.length === 0 && (
                  <p className="text-center text-slate-400 py-8">조건에 맞는 문서가 없습니다.</p>
                )}
              </div>
            </div>

            {/* 우측 그래프뷰 (sticky top-8 적용하여 스크롤 시 화면 고정) */}
            <div className="w-[372px] bg-white p-4 rounded-2xl shadow-sm border border-slate-200 flex flex-col items-center sticky top-8">
              <div className="flex w-full items-center justify-between mb-2">
                <span className="text-xs font-bold text-slate-400">그래프뷰</span>
                <button type="button" onClick={() => setIsGraphModalOpen(true)} className="rounded-lg border border-slate-200 bg-slate-50 p-1.5 text-slate-600 hover:bg-blue-50 hover:text-blue-700" aria-label="그래프 전체 화면">
                  <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/><path d="M2 2l4 4M14 2l-4 4M14 14l-4-4M2 14l4-4"/></svg>
                </button>
              </div>
              <div className="bg-slate-50 rounded-xl overflow-hidden border border-slate-100 cursor-grab active:cursor-grabbing">
                <svg ref={minimapRef} width="340" height="340" className="w-[340px] h-[340px]"></svg>
                <div className="w-full max-h-20 overflow-y-auto flex flex-wrap gap-x-3 gap-y-1 px-1 pt-2">
                  {graphCategories.slice(0, 12).map(category => (
                    <span key={category || '__uncategorized__'} className="inline-flex items-center gap-1 text-[10px] text-slate-500">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: getCategoryColor(category) }} />
                      {category || '카테고리 없음'}
                    </span>
                  ))}
                  {graphCategories.length > 12 && <span className="text-[10px] text-slate-400">외 {graphCategories.length - 12}개</span>}
                </div>
              </div>
            </div>
          </div>
        )}

        {(currentView === 'detail' || currentView === 'edit') && (
          <div className="w-full max-w-7xl flex gap-8 items-start justify-center">
            {/* 메인 컨텐츠 박스 */}
            <div className="flex-1 bg-white p-8 rounded-2xl shadow-sm border border-slate-200 flex flex-col min-h-[750px]">
              {currentView === 'detail' && selectedTerm && (
                <div className="flex flex-col gap-6">
                  <div className="border-b border-slate-100 pb-4 flex justify-between items-center">
                    <div>
                      <h3 className="text-3xl font-black text-slate-900 mb-1">{selectedTerm.title}</h3>
                      <div className="flex gap-2 items-center">
                        <span className="text-xs bg-slate-100 text-slate-500 font-mono px-2.5 py-1 rounded-md">
                          slug: {selectedTerm.slug}
                        </span>
                        {(selectedTerm.linked_slugs || []).length > 0 && <span className="text-xs bg-blue-50 text-blue-600 px-2.5 py-1 rounded-md">연결된 노드 {selectedTerm.linked_slugs?.length}개</span>}
                        {selectedTerm.category && <span className="text-xs bg-indigo-50 text-indigo-700 px-2.5 py-1 rounded-md">{selectedTerm.category}</span>}
                      </div>
                      {parseTags(selectedTerm.tags).length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mt-2">
                          {parseTags(selectedTerm.tags).map(tag => <span key={tag} className="text-xs bg-slate-100 text-slate-600 px-2 py-1 rounded-md">#{tag}</span>)}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={openEditView}
                        className="text-sm bg-amber-50 text-amber-700 font-bold px-3 py-2 rounded-xl hover:bg-amber-100 transition border border-amber-200"
                      >
                        수정
                      </button>
                      <button
                        onClick={() => handleDelete(selectedTerm.slug)}
                        className="text-sm bg-rose-50 text-rose-700 font-bold px-3 py-2 rounded-xl hover:bg-rose-100 transition border border-rose-200"
                      >
                        삭제
                      </button>
                      <button
                        onClick={() => setCurrentView('home')}
                        className="text-sm bg-slate-100 text-slate-700 font-bold px-4 py-2 rounded-xl hover:bg-slate-200 transition"
                      >
                        홈으로
                      </button>
                    </div>
                  </div>
                  <div
                    className="prose max-w-none text-slate-700 min-h-[400px] leading-relaxed text-base [&_a]:text-blue-600 [&_a]:underline"
                    onClick={event => {
                      const target = event.target as HTMLElement
                      const anchor = target.closest('a[data-wikilink-slug]') as HTMLAnchorElement | null
                      const slug = anchor?.getAttribute('data-wikilink-slug')
                      if (slug) {
                        event.preventDefault()
                        fetchTermDetail(slug)
                        return
                      }
                      const spoiler = target.closest('[data-spoiler="true"]') as HTMLElement | null
                      if (spoiler) {
                        spoiler.style.background = 'transparent'
                        spoiler.style.color = 'inherit'
                      }
                    }}
                    dangerouslySetInnerHTML={{ __html: renderDocumentHtml(selectedTerm.content || '', allTerms) }}
                  />
                  <div className="text-xs text-slate-400 border-t border-slate-100 pt-4 flex justify-end">
                    <span className="font-mono">최종 수정일: {selectedTerm.updated_at}</span>
                  </div>
                </div>
              )}

              {currentView === 'edit' && (
                <div className="flex flex-col flex-1 gap-6" onKeyDown={handleEditKeyDown}>
                  <div className="border-b border-slate-100 pb-4 flex justify-between items-center">
                    <div className="flex items-center gap-4">
                      <div>
                        <h3 className="text-xl font-black text-slate-800">{editTitle}</h3>
                        <span className="text-xs text-slate-400">
                          {editLinkedSlugs.length ? `연결된 노드 ${editLinkedSlugs.length}개` : '연결된 노드 없음'}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setTempTitle(editTitle)
                                          setTempCategory(editCategory)
                          setTempTagsText(editTagsText)
                                          setMetaTagSearch('')
                          setIsMetaModalOpen(true)
                        }}
                        className="text-xs bg-slate-100 text-slate-700 font-bold px-3 py-1.5 rounded-xl hover:bg-slate-200 transition border border-slate-200"
                      >
                        설정 변경
                      </button>
                    </div>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={handleCancelEdit}
                        className="bg-slate-200 text-slate-700 px-4 py-2 rounded-xl text-sm font-bold hover:bg-slate-300 transition"
                      >
                        취소
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSaveEdit()}
                        className="bg-emerald-600 text-white px-5 py-2 rounded-xl text-sm font-bold shadow-md hover:bg-emerald-700 transition"
                      >
                        저장하기
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-col flex-1 gap-2 relative">
                    <div className="flex justify-between items-center">
                      <div className="flex flex-col gap-0.5">
                        <label className="block text-xs font-bold text-slate-500 uppercase">본문 내용</label>
                        <span className="text-[10px] text-slate-400">Markdown 서식은 저장 후 문서 보기에서 적용됩니다. [[문서 제목]] 입력 시 자동완성으로 문서를 연결할 수 있습니다.</span>
                      </div>
                      <input
                        type="file"
                        ref={fileInputRef}
                        accept="image/*"
                        onChange={handleImageUpload}
                        className="hidden"
                      />
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="text-xs bg-blue-50 text-blue-600 font-bold px-3 py-1 rounded-lg hover:bg-blue-100 transition border border-blue-200"
                      >
                        이미지 파일 업로드
                      </button>
                    </div>
                    {wikiLinkQuery !== null && (
                      <div className="fixed z-[80] w-[360px] max-w-[calc(100vw-24px)] rounded-xl border border-slate-200 bg-white shadow-xl max-h-52 overflow-y-auto" style={{ top: wikiLinkPosition?.top ?? 12, left: wikiLinkPosition?.left ?? 12 }}>
                        <div className="px-3 py-2 text-[10px] font-bold uppercase tracking-wide text-slate-400">문서 링크 · 선택하거나 제목을 계속 입력하세요</div>
                        {allTerms
                          .filter(term => term.slug !== editSlug && (!wikiLinkQuery.trim() || `${term.title} ${term.slug} ${term.category || ''} ${parseTags(term.tags).join(' ')}`.toLocaleLowerCase().includes(wikiLinkQuery.toLocaleLowerCase())))
                          .slice(0, 8)
                          .map(term => (
                            <button key={term.slug} type="button" onMouseDown={event => event.preventDefault()} onClick={() => insertWikiLinkSuggestion(term)}
                              className="w-full px-3 py-2 text-left hover:bg-blue-50 border-t border-slate-100">
                              <span className="block text-sm font-semibold text-slate-800">{term.title}</span>
                              <span className="block text-[10px] text-slate-400">{term.slug} · {term.category || '카테고리 없음'}</span>
                            </button>
                          ))}
                        {allTerms.filter(term => term.slug !== editSlug && (!wikiLinkQuery.trim() || `${term.title} ${term.slug}`.toLocaleLowerCase().includes(wikiLinkQuery.toLocaleLowerCase()))).length === 0 && (
                          <p className="px-3 py-3 text-xs text-slate-400">일치하는 문서가 없습니다.</p>
                        )}
                      </div>
                    )}
                    <div
                      ref={editorRef}
                      contentEditable
                      suppressContentEditableWarning
                      onInput={handleEditorInput}
                      onKeyDown={handleEditorKeyDown}
                      onKeyUp={() => { rememberEditorSelection(); updateWikiLinkQueryAtCaret() }}
                      onMouseUp={() => { rememberEditorSelection(); updateWikiLinkQueryAtCaret() }}
                      onFocus={() => { rememberEditorSelection(); updateWikiLinkQueryAtCaret() }}
                      onPaste={handlePaste}
                      onClick={event => {
                        const target = event.target as HTMLElement
                        const spoiler = target.closest('[data-spoiler="true"]') as HTMLElement | null
                        if (spoiler) {
                          spoiler.style.background = 'transparent'
                          spoiler.style.color = 'inherit'
                          return
                        }
                        const anchor = target.closest('a[href]') as HTMLAnchorElement | null
                        if (!anchor || !editorRef.current?.contains(anchor)) return
                        if (!event.ctrlKey && !event.metaKey) {
                          event.preventDefault()
                          return
                        }
                        event.preventDefault()
                        event.stopPropagation()
                        window.open(anchor.href, '_blank', 'noopener,noreferrer')
                      }}
                      className="prose prose-sm max-w-none w-full flex-1 min-h-[550px] whitespace-pre-wrap overflow-y-auto bg-white border border-slate-300 rounded-xl p-4 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-blue-500 [&_a]:text-blue-600 [&_a]:underline"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* 우측 그래프뷰 영역 (sticky top-8 적용하여 스크롤 시 화면 고정) */}
            <div className="w-[372px] bg-white p-4 rounded-2xl shadow-sm border border-slate-200 flex flex-col items-center sticky top-8">
              <div className="flex w-full items-center justify-between mb-2">
                <span className="text-xs font-bold text-slate-400">그래프뷰</span>
                <button type="button" onClick={() => { setGraphPreviewTerm(null); setIsGraphModalOpen(true) }} className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-semibold text-slate-600 hover:bg-blue-50 hover:text-blue-700">
                  확대
                </button>
              </div>
              <div className="bg-slate-50 rounded-xl overflow-hidden border border-slate-100 cursor-grab active:cursor-grabbing">
                <svg ref={minimapRef} width="340" height="340" className="w-[340px] h-[340px]"></svg>
                <div className="w-full max-h-20 overflow-y-auto flex flex-wrap gap-x-3 gap-y-1 px-1 pt-2">
                  {graphCategories.slice(0, 12).map(category => (
                    <span key={category || '__uncategorized__'} className="inline-flex items-center gap-1 text-[10px] text-slate-500">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: getCategoryColor(category) }} />
                      {category || '카테고리 없음'}
                    </span>
                  ))}
                  {graphCategories.length > 12 && <span className="text-[10px] text-slate-400">외 {graphCategories.length - 12}개</span>}
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {isGraphModalOpen && (
        <div className="fixed inset-0 z-[65] flex items-center justify-center bg-slate-950/75 backdrop-blur-sm p-1.5 sm:p-2">
          <div className="flex h-[98vh] max-h-[98vh] w-[99vw] max-w-none flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
            <div className="flex shrink-0 items-center justify-between border-b border-slate-700 px-5 py-3">
              <div>
                <h3 className="text-sm font-bold text-slate-100">그래프뷰 확대</h3>
                <p className="text-[11px] text-slate-400">노드를 클릭하면 문서 미리보기가 열립니다. 드래그로 이동하고 휠로 확대·축소할 수 있습니다.</p>
              </div>
              <button type="button" onClick={() => { setIsGraphModalOpen(false); setGraphPreviewTerm(null) }} className="rounded-lg bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-700">닫기</button>
            </div>
            <div className="relative min-h-0 flex-1 overflow-hidden bg-slate-50">
              <svg ref={largeGraphRef} width="960" height="680" className="block h-full w-full rounded-lg bg-slate-50 cursor-grab active:cursor-grabbing"></svg>
              {graphPreviewTerm && (
                <aside className="absolute right-4 top-4 bottom-4 z-10 flex w-[340px] max-w-[calc(100%-2rem)] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white/95 shadow-2xl backdrop-blur-sm">
                  <div className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-100 px-4 py-3">
                    <div className="min-w-0">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-blue-600">문서 미리보기</p>
                      <h4 className="mt-1 break-words text-base font-bold text-slate-900">{graphPreviewTerm.title}</h4>
                    </div>
                    <button type="button" aria-label="미리보기 닫기" onClick={() => setGraphPreviewTerm(null)} className="shrink-0 rounded-lg px-2 py-1 text-lg font-bold text-slate-400 hover:bg-slate-100 hover:text-slate-700">×</button>
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                    <div className="mb-3 flex flex-wrap gap-1.5">
                      <span className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[10px] font-semibold" style={{ color: getCategoryColor(graphPreviewTerm.category) }}>{graphPreviewTerm.category || '카테고리 없음'}</span>
                      {parseTags(graphPreviewTerm.tags).map(tag => (
                        <span key={tag} className="rounded-md bg-violet-50 px-2 py-1 text-[10px] font-semibold text-violet-700">#{tag}</span>
                      ))}
                    </div>
                    <p className="whitespace-pre-wrap break-words text-xs leading-6 text-slate-600">
                      {(() => {
                        const preview = getTermPreviewText(graphPreviewTerm.content)
                        return preview ? `${preview.slice(0, 320)}${preview.length > 320 ? '…' : ''}` : '미리 볼 수 있는 본문 내용이 없습니다.'
                      })()}
                    </p>
                  </div>
                  <div className="shrink-0 border-t border-slate-100 p-3">
                    <button
                      type="button"
                      onClick={() => {
                        const slug = graphPreviewTerm.slug
                        setGraphPreviewTerm(null)
                        setIsGraphModalOpen(false)
                        void fetchTermDetail(slug)
                      }}
                      className="w-full rounded-xl bg-blue-600 px-4 py-2.5 text-xs font-bold text-white shadow-sm transition hover:bg-blue-700"
                    >
                      해당 문서로 이동
                    </button>
                  </div>
                </aside>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap gap-3 border-t border-slate-700 px-5 py-3">
              {graphCategories.slice(0, 18).map(category => (
                <span key={category || '__uncategorized__'} className="inline-flex items-center gap-1 text-[10px] text-slate-300">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: getCategoryColor(category) }} />
                  {category || '카테고리 없음'}
                </span>
              ))}
              {graphCategories.length > 18 && <span className="text-[10px] text-slate-400">외 {graphCategories.length - 18}개</span>}
            </div>
          </div>
        </div>
      )}

      {isTestToolsOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/55 backdrop-blur-sm p-4">
          <div className="flex w-full max-w-md flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-lg font-bold text-slate-900">그래프 부하 테스트</h3>
                <p className="text-xs text-slate-500">일반 문서와 구분되는 테스트 노드를 생성합니다.</p>
              </div>
              <button type="button" onClick={() => setIsTestToolsOpen(false)} className="text-xl font-bold text-slate-400 hover:text-slate-700">×</button>
            </div>
            <div className="rounded-xl border border-violet-100 bg-violet-50 p-3 text-xs leading-relaxed text-violet-900">
              테스트 노드는 '테스트 노드(숫자)' 형식으로 생성되며, 최대 10,000개까지 한 번에 추가할 수 있습니다. 테스트 노드는 일반 문서와 분리된 표시자로 저장되어 아래 정리 기능으로만 일괄 삭제됩니다.
            </div>
            <div className="flex items-start gap-2 rounded-xl border border-slate-200 bg-white px-3 py-3">
              <input id="link-test-node-groups" type="checkbox" checked={linkTestNodeGroups} onChange={event => setLinkTestNodeGroups(event.target.checked)} className="mt-0.5 h-4 w-4 rounded border-slate-300 text-violet-600 focus:ring-violet-500" />
              <label htmlFor="link-test-node-groups" className="cursor-pointer">
                <span className="block text-xs font-bold text-slate-700">테스트 노드를 그룹으로 연결</span>
                <span className="mt-1 block text-[11px] leading-relaxed text-slate-500">체크하면 최대 20개씩 독립된 그룹으로 연결합니다. 그룹 간에는 링크가 생성되지 않습니다.</span>
              </label>
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-xs font-bold text-slate-600" htmlFor="test-node-count">생성할 노드 수</label>
              <input id="test-node-count" type="number" min="1" max="10000" step="1" value={testNodeCount} onChange={event => setTestNodeCount(event.target.value)} className="w-full rounded-xl border border-slate-300 bg-slate-50 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500" />
              <p className="text-[11px] text-slate-400">예: 500을 입력하면 테스트 노드(1)부터 테스트 노드(500)까지 생성합니다.</p>
            </div>
            {testNodeFeedback && <p className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">{testNodeFeedback}</p>}
            <div className="flex flex-col gap-2 border-t border-slate-100 pt-3">
              <button type="button" disabled={isTestNodeBusy} onClick={handleGenerateTestNodes} className="rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-violet-700 disabled:opacity-50">
                {isTestNodeBusy ? '처리 중...' : `테스트 노드 ${testNodeCount || '0'}개 생성`}
              </button>
              <button type="button" disabled={isTestNodeBusy} onClick={handleDeleteTestNodes} className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm font-bold text-rose-700 hover:bg-rose-100 disabled:opacity-50">
                테스트 노드 전체 삭제
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 새 문서 생성 모달 창 */}
      {isModalOpen && (
        <div 
          className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4"
        >
          <div
            className="bg-white w-full max-w-md p-6 rounded-2xl shadow-2xl border border-slate-200 flex flex-col gap-4 max-h-[90vh] overflow-y-auto"
            onKeyDown={event => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault()
                void handleProceedToEdit()
              }
            }}
          >
            <div className="flex justify-between items-center border-b pb-3">
              <h3 className="text-lg font-bold text-slate-800">새 문서 생성</h3>
              <button
                onClick={() => setIsModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 font-bold text-lg"
              >
                &times;
              </button>
            </div>
            <div className="flex flex-col gap-4">
              <p className="text-[11px] leading-relaxed text-slate-500">문서 간 연결은 작성 화면 본문에서 <span className="font-semibold text-blue-600">[[문서 제목]]</span> 형식으로 입력하면 자동으로 그래프에 반영됩니다.</p>
              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">문서 제목</label>
                <input
                  type="text"
                  placeholder="문서 제목을 입력하세요"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl p-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  autoFocus
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">카테고리</label>
                <div className="rounded-xl border border-slate-300 bg-slate-50 p-3 flex flex-col gap-2">
                  {newCategory && (
                    <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2">
                      <span className="text-xs font-semibold" style={{ color: getCategoryColor(newCategory) }}>선택됨 · {newCategory}</span>
                      <button type="button" onClick={() => setNewCategory('')} className="text-xs text-slate-400 hover:text-slate-700">선택 해제</button>
                    </div>
                  )}
                  <input
                    value={createCategorySearch}
                    onChange={e => setCreateCategorySearch(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && createCategorySearch.trim()) {
                        e.preventDefault()
                        addCreateCategory(createCategorySearch)
                      }
                    }}
                    placeholder="카테고리 검색 또는 새 카테고리 입력..."
                    className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[10px] font-bold text-slate-400">{normalizedCreateCategorySearch ? '검색 결과' : '추천 카테고리'}</span>
                    <div className="max-h-28 overflow-y-auto flex flex-wrap gap-2">
                      {createCategoryChoices.map(category => (
                        <button key={category} type="button" onClick={() => addCreateCategory(category)}
                          className="rounded-lg border bg-white px-3 py-1.5 text-xs font-semibold transition hover:bg-slate-100"
                          style={{ borderColor: getCategoryColor(category), color: getCategoryColor(category) }}>
                          {category}
                        </button>
                      ))}
                      {createCategoryCanBeAdded && (
                        <button type="button" onClick={() => addCreateCategory(createCategorySearch)}
                          className="rounded-lg border border-dashed border-blue-300 bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-100">
                          + 새 카테고리 "{createCategorySearch.trim()}"
                        </button>
                      )}
                      {createCategoryChoices.length === 0 && !createCategoryCanBeAdded && (
                        <span className="text-xs text-slate-400">표시할 카테고리가 없습니다.</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">태그 (복수 선택)</label>
                <div className="rounded-xl border border-slate-300 bg-slate-50 p-3 flex flex-col gap-2">
                  {createSelectedTags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {createSelectedTags.map(tag => (
                        <span key={tag} className="inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-[11px] font-semibold text-blue-700">
                          #{tag}
                          <button type="button" onClick={() => setNewTagsText(current => parseTags(current).filter(item => item.toLocaleLowerCase() !== tag.toLocaleLowerCase()).join(', '))} className="text-blue-400 hover:text-blue-800" aria-label={`${tag} 태그 제거`}>×</button>
                        </span>
                      ))}
                    </div>
                  )}
                  <input
                    value={createTagSearch}
                    onChange={e => setCreateTagSearch(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && createTagSearch.trim()) {
                        e.preventDefault()
                        addCreateTag(createTagSearch)
                      }
                    }}
                    placeholder="태그 검색 또는 새 태그 입력..."
                    className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[10px] font-bold text-slate-400">{normalizedCreateTagSearch ? '검색 결과' : '추천 태그'}</span>
                    <div className="max-h-28 overflow-y-auto flex flex-wrap gap-1.5">
                      {createTagChoices.map(tag => (
                        <button key={tag} type="button" onClick={() => addCreateTag(tag)} className="rounded-full bg-blue-50 text-blue-700 border border-blue-100 px-2.5 py-1 text-[11px] hover:bg-blue-100">+ {tag}</button>
                      ))}
                      {createTagCanBeAdded && (
                        <button type="button" onClick={() => addCreateTag(createTagSearch)}
                          className="rounded-full border border-dashed border-blue-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-blue-700 hover:bg-blue-50">
                          + 새 태그 "{createTagSearch.trim()}"
                        </button>
                      )}
                      {createTagChoices.length === 0 && !createTagCanBeAdded && (
                        <span className="text-[11px] text-slate-400">추천 태그가 없습니다. 검색창에 새 태그를 입력해 추가할 수 있습니다.</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex justify-end gap-2 mt-4 pt-3 border-t">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="bg-slate-200 text-slate-700 px-5 py-2.5 rounded-xl text-sm font-bold hover:bg-slate-300 transition"
                >
                  취소
                </button>
                <button
                  type="button"
                  onClick={() => handleProceedToEdit()}
                  className="bg-blue-600 text-white px-5 py-2.5 rounded-xl text-sm font-bold shadow-md hover:bg-blue-700 transition"
                >
                  내용 작성하기
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 문서 메타데이터 및 링크드 노드 설정 모달 */}
      {isMetaModalOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white w-full max-w-md p-6 rounded-2xl shadow-2xl border border-slate-200 flex flex-col gap-4 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center border-b pb-3">
              <h3 className="text-lg font-bold text-slate-800">문서 설정 변경</h3>
              <button
                onClick={() => setIsMetaModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 font-bold text-lg"
              >
                &times;
              </button>
            </div>
            <div className="flex flex-col gap-4">
              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">문서 제목</label>
                <input
                  type="text"
                  value={tempTitle}
                  onChange={(e) => setTempTitle(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl p-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">카테고리</label>
                <input
                  list="meta-category-options"
                  value={tempCategory}
                  onChange={(e) => setTempCategory(e.target.value)}
                  placeholder="카테고리 입력"
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl p-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <datalist id="meta-category-options">
                  {categories.map(category => <option key={category} value={category} />)}
                </datalist>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">태그</label>
                <input
                  value={tempTagsText}
                  onChange={(e) => setTempTagsText(e.target.value)}
                  placeholder="쉼표로 구분해 입력"
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl p-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <div className="mt-2 flex flex-col gap-1.5">
                  <input value={metaTagSearch} onChange={e => setMetaTagSearch(e.target.value)} placeholder="관련 태그 검색..." className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  <div className="flex flex-wrap gap-1.5">
                    {metaTagChoices.map(tag => <button key={tag} type="button" onClick={() => setTempTagsText(current => appendTag(current, tag))} className="rounded-full bg-blue-50 text-blue-700 border border-blue-100 px-2.5 py-1 text-[11px] hover:bg-blue-100">+ {tag}</button>)}
                    {metaTagChoices.length === 0 && <span className="text-[11px] text-slate-400">추천 태그가 없어. 새 태그를 직접 입력할 수 있어.</span>}
                  </div>
                </div>
              </div>

              <div className="flex justify-end gap-2 mt-4 pt-3 border-t">
                <button
                  type="button"
                  onClick={() => setIsMetaModalOpen(false)}
                  className="bg-slate-200 text-slate-700 px-5 py-2.5 rounded-xl text-sm font-bold hover:bg-slate-300 transition"
                >
                  취소
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    if (!tempTitle.trim()) {
                      showErrorTab("제목을 입력해주세요.")
                      return
                    }
                    try {
                      const content = editorRef.current?.innerText ?? editContent
                      const linkedSlugs = extractWikiLinkedSlugs(content, allTerms, editSlug)
                      const saveRes = await fetch(`${API_BASE_URL}/api/terms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: editSlug, title: tempTitle, content, category: tempCategory.trim() || null, tags: parseTags(tempTagsText), linked_slugs: linkedSlugs }) })
                      if (!saveRes.ok) { const data = await saveRes.json().catch(() => ({})); throw new Error(data.error || `설정을 저장하지 못했습니다. (${saveRes.status})`) }
                      setEditTitle(tempTitle)
                      setEditLinkedSlugs(linkedSlugs)
                      setEditCategory(tempCategory)
                      setEditTagsText(tempTagsText)
                      await fetchData()
                      setIsMetaModalOpen(false)
                    } catch (err) {
                      console.error('문서 설정 저장 실패:', err)
                      showErrorTab(err instanceof Error ? err.message : '문서 설정을 저장하지 못했습니다.')
                    }
                  }}
                  className="bg-blue-600 text-white px-5 py-2.5 rounded-xl text-sm font-bold shadow-md hover:bg-blue-700 transition"
                >
                  적용하기
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {deleteTargetSlug && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[70] p-4" role="presentation">
          <div className="bg-white w-full max-w-sm rounded-2xl shadow-2xl border border-slate-200 p-6 flex flex-col gap-4" role="dialog" aria-modal="true" aria-labelledby="delete-dialog-title">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-rose-100 text-rose-600 flex items-center justify-center shrink-0">
                <span className="text-lg font-bold">!</span>
              </div>
              <div className="min-w-0">
                <h3 id="delete-dialog-title" className="text-lg font-bold text-slate-900">문서를 삭제할까요?</h3>
                <p className="mt-1 text-sm text-slate-500">삭제한 문서는 복구할 수 없습니다.</p>
                <p className="mt-2 text-xs font-mono text-slate-400 break-all">{deleteTargetSlug}</p>
              </div>
            </div>
            {deleteError && <p className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-lg p-3">{deleteError}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={isDeleting}
                onClick={() => { setDeleteTargetSlug(null); setDeleteError('') }}
                className="px-4 py-2 rounded-xl text-sm font-bold bg-slate-100 text-slate-700 hover:bg-slate-200 disabled:opacity-50"
              >취소</button>
              <button
                ref={deleteConfirmButtonRef}
                type="button"
                disabled={isDeleting}
                onClick={confirmDelete}
                className="px-4 py-2 rounded-xl text-sm font-bold bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-50"
              >{isDeleting ? '삭제 중...' : '삭제하기'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}