import React, { useEffect, useRef, useState } from 'react'
import * as d3 from 'd3'

interface Node {
  id: number
  slug: string
  title: string
  parent_slug?: string | null
  radius?: number
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
  updated_at: string
}

// 상시 가동 중인 Cloudflare Worker 백엔드 주소
const API_BASE_URL = 'https://iot-glossary.smh13918957.workers.dev'

export default function App() {
  const minimapRef = useRef<SVGSVGElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const editorRef = useRef<HTMLDivElement | null>(null)

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
  
  // 검색어 상태
  const [searchQuery, setSearchQuery] = useState('')
  
  // 문서 생성 모달 상태
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [selectedParentSlug, setSelectedParentSlug] = useState('')
  const [selectedChildSlugs, setSelectedChildSlugs] = useState<string[]>([])
  const [isCreateParentOpen, setIsCreateParentOpen] = useState(true)

  // 문서 편집/작성 상태
  const [editSlug, setEditSlug] = useState('')
  const [editTitle, setEditTitle] = useState('')
  const [editContent, setEditContent] = useState('')
  const [editParentSlug, setEditParentSlug] = useState('')

  // 제목/상위/하위노드 편집 모달 상태
  const [isMetaModalOpen, setIsMetaModalOpen] = useState(false)
  const [tempTitle, setTempTitle] = useState('')
  const [tempParentSlug, setTempParentSlug] = useState('')
  const [tempChildSlugs, setTempChildSlugs] = useState<string[]>([])
  const [isMetaParentOpen, setIsMetaParentOpen] = useState(true)

  // 상위 노드 존재 여부를 엄격하고 안전하게 판별하는 헬퍼 함수
  const hasParentNode = (nodeSlug: string, parentSlug?: string | null, currentLinks?: Link[]) => {
    if (parentSlug) {
      const trimmed = parentSlug.trim()
      if (trimmed !== '' && trimmed !== 'null' && trimmed !== 'undefined') {
        return true
      }
    }
    if (currentLinks) {
      const targetNode = nodes.find(n => n.slug === nodeSlug)
      if (targetNode) {
        const hasIncomingLink = currentLinks.some(l => {
          const tId = typeof l.target === 'object' ? (l.target as any).id : l.target
          return tId === targetNode.id
        })
        if (hasIncomingLink) return true
      }
    }
    return false
  }

  // 노드 반지름 계산 함수 (활성화 노드 14, 최상위 13, 하위 8)
  const getNodeRadius = (node: Node, activeSlug: string, currentLinks?: Link[]) => {
    if (node.slug === activeSlug) return 14
    return hasParentNode(node.slug, node.parent_slug, currentLinks) ? 8 : 13
  }

  // 데이터 로드 및 반지름 동기화
  const fetchData = async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/terms`)
      const data = await res.json()
      if (data && data.nodes) {
        const rawNodes: Node[] = data.nodes
        const rawLinks: Link[] = data.links || []
        const processedNodes = rawNodes.map(node => ({
          ...node,
          radius: hasParentNode(node.slug, node.parent_slug, rawLinks) ? 8 : 13
        }))
        setNodes(processedNodes)
        setLinks(rawLinks)
        setAllTerms(data.terms || processedNodes)
      }
    } catch (err) {
      console.error("데이터 로드 실패:", err)
    }
  }

  useEffect(() => {
    fetchData()
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

  // 에디터 진입 시 초기 내용 반영 및 자동 포커스
  useEffect(() => {
    if (currentView === 'edit' && editorRef.current) {
      editorRef.current.innerHTML = editContent
      editorRef.current.focus()
    }
  }, [currentView])

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
      const res = await fetch(`${API_BASE_URL}/api/terms/${slug}`)
      const data = await res.json()
      if (data.term) {
        setSelectedTerm(data.term)
        setCurrentView('detail')
        setSearchQuery('')
        addRecentSlug(slug)
      }
    } catch (err) {
      console.error("상세 조회 실패:", err)
    }
  }

  // 노드 컬러 계산 (최상위 노드만 고유 HSL 컬러 지정)
  const getNodeColor = (node: Node, activeSlug: string) => {
    if (node.slug === activeSlug) return '#1d4ed8'
    
    if (!hasParentNode(node.slug, node.parent_slug, links)) {
      let hash = 0;
      for (let i = 0; i < node.slug.length; i++) {
        hash = node.slug.charCodeAt(i) + ((hash << 5) - hash);
      }
      const h = Math.abs(hash) % 360;
      return `hsl(${h}, 70%, 45%)`;
    }
    
    return '#2563eb'
  }

  // 그래프 뷰 D3 렌더링
  useEffect(() => {
    if (!minimapRef.current) return

    const svg = d3.select(minimapRef.current)
    svg.selectAll("*").remove()

    if (currentView === 'home') {
      return
    }

    const width = 340
    const height = 340

    // 화살표 마커 정의
    svg.append("defs").selectAll("marker")
      .data(["end"])
      .enter().append("marker")
      .attr("id", String)
      .attr("viewBox", "0 -5 10 10")
      .attr("refX", 18)
      .attr("refY", 0)
      .attr("markerWidth", 6)
      .attr("markerHeight", 6)
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,-5L10,0L0,5")
      .attr("fill", "#94a3b8")

    const container = svg.append("g")

    const zoom = d3.zoom()
      .scaleExtent([0.1, 4])
      .on("zoom", (event) => {
        container.attr("transform", event.transform)
      })

    svg.call(zoom as any)

    const activeSlug = selectedTerm?.slug || editSlug
    let relevantNodes = nodes
    let relevantLinks = links

    if (currentView === 'detail' || currentView === 'edit') {
      const currentNode = nodes.find(n => n.slug === activeSlug)
      const currentParent = editParentSlug || currentNode?.parent_slug || ''

      relevantNodes = nodes.filter(n => {
        if (!currentNode) return true
        const isCurrent = n.slug === currentNode.slug
        const isParent = n.slug === currentParent
        const nParents = n.parent_slug || ''
        const isChild = nParents.includes(currentNode.slug)
        return isCurrent || isParent || isChild
      })

      const relevantNodeIds = new Set(relevantNodes.map(n => n.id))
      relevantLinks = links.filter(l => {
        const sourceId = typeof l.source === 'object' ? (l.source as any).id : l.source
        const targetId = typeof l.target === 'object' ? (l.target as any).id : l.target
        return relevantNodeIds.has(sourceId) && relevantNodeIds.has(targetId)
      })
    }

    if (relevantNodes.length === 0) return

    // 물리 시뮬레이션 설정 (링크 엉킴 방지)
    const simulation = d3.forceSimulation(relevantNodes as d3.SimulationNodeDatum[])
      .alphaDecay(0.06)
      .velocityDecay(0.3)
      .force("link", d3.forceLink(relevantLinks).id((d: any) => d.id).distance(110))
      .force("charge", d3.forceManyBody().strength(-220))
      .force("x", d3.forceX(width / 2).strength(0.05))
      .force("y", d3.forceY(height / 2).strength(0.05))
      .force("collide", d3.forceCollide().radius((d: any) => getNodeRadius(d, activeSlug, links) + 22))

    // 1. 링크 레이어
    const link = container.append("g")
      .selectAll("line")
      .data(relevantLinks)
      .enter()
      .append("line")
      .attr("stroke", "#cbd5e1")
      .attr("stroke-width", 1.5)
      .attr("marker-end", "url(#end)")

    // 2. 노드 그룹 레이어
    const node = container.append("g")
      .selectAll("g")
      .data(relevantNodes)
      .enter()
      .append("g")
      .call(d3.drag<SVGGElement, any>()
        .on("start", (event, d) => {
          if (!event.active) simulation.alphaTarget(0.3).restart()
          d.fx = d.x
          d.fy = d.y
          d3.select(event.sourceEvent.target.closest('g') || event.sourceEvent.target.parentNode).raise()
        })
        .on("drag", (event, d) => {
          d.fx = event.x
          d.fy = event.y
        })
        .on("end", (event, d) => {
          if (!event.active) simulation.alphaTarget(0)
          d.fx = null
          d.fy = null
        })
      )

    node.append("circle")
      .attr("r", (d: any) => getNodeRadius(d, activeSlug, links))
      .attr("fill", (d: any) => getNodeColor(d, activeSlug))
      .attr("stroke", "#ffffff")
      .attr("stroke-width", 2)
      .attr("cursor", "grab")
      .on("mousedown", function() {
        d3.select(this.parentNode as any).raise()
      })
      .on("click", (event, d) => {
        event.stopPropagation()
        fetchTermDetail(d.slug)
      })

    // 3. 텍스트 레이어
    const textGroup = container.append("g")
    const textSelection = textGroup
      .selectAll("text")
      .data(relevantNodes)
      .enter()
      .append("text")
      .text((d: any) => d.title)
      .attr("x", (d: any) => getNodeRadius(d, activeSlug, links) + 4)
      .attr("y", 4)
      .attr("fill", "#1e293b")
      .attr("font-size", "11px")
      .attr("font-family", '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif')
      .attr("font-weight", (d: any) => d.slug === activeSlug ? "800" : "600")
      .attr("cursor", "pointer")
      .on("click", (event, d) => {
        event.stopPropagation()
        fetchTermDetail(d.slug)
      })

    const fitView = () => {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
      relevantNodes.forEach((d: any) => {
        if (d.x < x0) x0 = d.x
        if (d.x > x1) x1 = d.x
        if (d.y < y0) y0 = d.y
        if (d.y > y1) y1 = d.y
      })

      const boundsWidth = (x1 - x0) || 1
      const boundsHeight = (y1 - y0) || 1
      const scale = Math.min(1.2, Math.max(0.2, 0.8 / Math.max(boundsWidth / width, boundsHeight / height)))
      const midX = (x0 + x1) / 2
      const midY = (y0 + y1) / 2

      svg.call(
        zoom.transform as any,
        d3.zoomIdentity
          .translate(width / 2 - scale * midX, height / 2 - scale * midY)
          .scale(scale)
      )
    }

    simulation.on("tick", () => {
      link
        .attr("x1", (d: any) => d.source.x)
        .attr("y1", (d: any) => d.source.y)
        .attr("x2", (d: any) => d.target.x)
        .attr("y2", (d: any) => d.target.y)

      node
        .attr("transform", (d: any) => `translate(${d.x}, ${d.y})`)

      textSelection
        .attr("transform", (d: any) => `translate(${d.x}, ${d.y})`)
    })

    simulation.on("end", fitView)

  }, [nodes, links, currentView, selectedTerm, editSlug, editParentSlug])

  // 하위 노드들의 부모 관계 동기화 헬퍼 함수
  const updateChildRelations = async (parentSlugStr: string, childSlugs: string[]) => {
    for (const term of allTerms) {
      const isSelectedChild = childSlugs.includes(term.slug)
      const currentParents = (term.parent_slug || '').split(',').map(s => s.trim()).filter(Boolean)
      const isCurrentlyChild = currentParents.includes(parentSlugStr)

      if (isSelectedChild && !isCurrentlyChild) {
        const newParents = [...currentParents, parentSlugStr].join(',')
        const updatedRadius = hasParentNode(term.slug, newParents) ? 8 : 13
        await fetch(`${API_BASE_URL}/api/terms`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            slug: term.slug,
            title: term.title,
            content: term.content,
            parent_slug: newParents,
            radius: updatedRadius
          })
        })
      } else if (!isSelectedChild && isCurrentlyChild) {
        const newParents = currentParents.filter(p => p !== parentSlugStr).join(',')
        const updatedRadius = hasParentNode(term.slug, newParents) ? 8 : 13
        await fetch(`${API_BASE_URL}/api/terms`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            slug: term.slug,
            title: term.title,
            content: term.content,
            parent_slug: newParents || null,
            radius: updatedRadius
          })
        })
      }
    }
  }

  // 내용 작성 탭 진입 시점에 정식 노드 생성
  const handleProceedToEdit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    if (!newTitle.trim()) return

    let baseSlug = newTitle.trim().toLowerCase().replace(/[^a-z0-9가-힣]+/g, '-')
    if (!baseSlug || baseSlug === '-') {
      baseSlug = 'term'
    }
    const slug = baseSlug + '-' + Date.now().toString().slice(-4)
    const initialRadius = hasParentNode(slug, selectedParentSlug) ? 8 : 13

    try {
      const res = await fetch(`${API_BASE_URL}/api/terms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: slug,
          title: newTitle,
          content: '', 
          parent_slug: selectedParentSlug || null,
          radius: initialRadius
        })
      })

      if (res.ok) {
        await updateChildRelations(slug, selectedChildSlugs)

        setIsModalOpen(false)
        setIsNewDraft(true)
        await fetchData()
        
        const detailRes = await fetch(`${API_BASE_URL}/api/terms/${slug}`)
        const detailData = await detailRes.json()
        if (detailData.term) {
          setSelectedTerm(detailData.term)
          setEditSlug(detailData.term.slug)
          setEditTitle(detailData.term.title)
          setEditContent(detailData.term.content)
          setEditParentSlug(detailData.term.parent_slug || '')
          setCurrentView('edit')
        }
      } else {
        const errData = await res.json().catch(() => ({}))
        alert("문서 생성에 실패했습니다: " + (errData.error || res.statusText))
      }
    } catch (err) {
      console.error("생성 에러:", err)
      alert("서버 통신 중 오류가 발생했습니다.")
    }
  }

  // 문서 저장
  const handleSaveEdit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    const updatedRadius = hasParentNode(editSlug, editParentSlug) ? 8 : 13

    try {
      const res = await fetch(`${API_BASE_URL}/api/terms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: editSlug,
          title: editTitle,
          content: editContent,
          parent_slug: editParentSlug || null,
          radius: updatedRadius
        })
      })

      if (res.ok) {
        setIsNewDraft(false)
        alert("문서가 성공적으로 저장되었습니다.")
        await fetchData()
        fetchTermDetail(editSlug)
      } else {
        alert("저장에 실패했습니다.")
      }
    } catch (err) {
      console.error("저장 에러:", err)
    }
  }

  // 작성 중 취소 처리
  const handleCancelEdit = async () => {
    if (isNewDraft) {
      try {
        await fetch(`${API_BASE_URL}/api/terms/${editSlug}`, {
          method: 'DELETE'
        })
        await fetchData()
      } catch (err) {
        console.error("임시 문서 삭제 실패:", err)
      }
      setIsNewDraft(false)
      setSelectedTerm(null)
      setCurrentView(previousView)
    } else {
      fetchTermDetail(editSlug)
    }
  }

  // 문서 삭제
  const handleDelete = async (slug: string) => {
    if (!confirm("정말 이 문서를 삭제하시겠습니까?")) return

    try {
      const res = await fetch(`${API_BASE_URL}/api/terms/${slug}`, {
        method: 'DELETE'
      })
      if (res.ok) {
        alert("문서가 삭제되었습니다.")
        await fetchData()

        setSelectedTerm(null)
        setCurrentView(previousView)
      } else {
        alert("삭제에 실패했습니다.")
      }
    } catch (err) {
      console.error("삭제 에러:", err)
    }
  }

  // 수정 모드 진입
  const openEditView = () => {
    if (!selectedTerm) return
    setIsNewDraft(false)
    setEditSlug(selectedTerm.slug)
    setEditTitle(selectedTerm.title)
    setEditContent(selectedTerm.content)
    setEditParentSlug(selectedTerm.parent_slug || '')
    setCurrentView('edit')
  }

  // 새 문서 모달 열기
  const openCreateModal = () => {
    setNewTitle('')
    setSelectedParentSlug('')
    setSelectedChildSlugs([])
    setIsCreateParentOpen(true)
    if (currentView === 'detail' && selectedTerm) {
      setSelectedParentSlug(selectedTerm.slug)
    }
    setIsModalOpen(true)
  }

  // 로컬 이미지 파일 업로드 핸들러
  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return

    const file = files[0]
    const reader = new FileReader()
    reader.onload = (event) => {
      const base64Str = event.target?.result as string
      const img = document.createElement('img')
      img.src = base64Str
      img.style.maxWidth = '100%'
      img.style.maxHeight = '450px'
      img.style.borderRadius = '12px'
      img.style.margin = '12px 0'

      const selection = window.getSelection()
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0)
        range.deleteContents()
        range.insertNode(img)
        range.collapse(false)
      } else if (editorRef.current) {
        editorRef.current.appendChild(img)
      }

      if (editorRef.current) {
        setEditContent(editorRef.current.innerHTML)
      }
    }
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  // 클립보드 이미지 붙여넣기 (Ctrl + V) 핸들러
  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const items = e.clipboardData.items
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        e.preventDefault()
        const file = items[i].getAsFile()
        if (!file) return
        const reader = new FileReader()
        reader.onload = (event) => {
          const base64Str = event.target?.result as string
          const img = document.createElement('img')
          img.src = base64Str
          img.style.maxWidth = '100%'
          img.style.maxHeight = '450px'
          img.style.borderRadius = '12px'
          img.style.margin = '12px 0'

          const selection = window.getSelection()
          if (selection && selection.rangeCount > 0) {
            const range = selection.getRangeAt(0)
            range.deleteContents()
            range.insertNode(img)
            range.collapse(false)
          } else if (editorRef.current) {
            editorRef.current.appendChild(img)
          }

          if (editorRef.current) {
            setEditContent(editorRef.current.innerHTML)
          }
        }
        reader.readAsDataURL(file)
      }
    }
  }

  // 모달창 엔터 키 핸들러
  const handleModalKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleProceedToEdit()
    }
  }

  // 작성/수정 페이지 단축키 (Ctrl + Enter) 핸들러
  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.ctrlKey && e.key === 'Enter') {
      e.preventDefault()
      handleSaveEdit()
    }
  }

  const filteredTerms = searchQuery.trim()
    ? allTerms.filter(t => t.title.toLowerCase().includes(searchQuery.toLowerCase().trim()))
    : []

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
            onClick={openCreateModal}
            className="bg-blue-600 text-white px-4 py-2 rounded-xl text-sm font-bold shadow-md hover:bg-blue-700 transition"
          >
            새 문서 생성
          </button>
        </div>
      </header>

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
                className="w-full bg-white border border-slate-300 rounded-xl px-4 py-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />

              {filteredTerms.length > 0 && (
                <div className="absolute left-0 right-0 top-full mt-2 bg-white border border-slate-200 rounded-xl shadow-xl max-h-60 overflow-y-auto z-20 text-left">
                  {filteredTerms.map((term) => (
                    <div
                      key={term.slug}
                      onClick={() => fetchTermDetail(term.slug)}
                      className="p-3 hover:bg-blue-50 cursor-pointer border-b border-slate-100 last:border-none transition flex justify-between items-center"
                    >
                      <span className="font-bold text-slate-800 text-sm">{term.title}</span>
                      <span className="text-xs text-slate-400 font-mono">{term.slug}</span>
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
                      className="p-3 bg-white border border-slate-200 rounded-xl hover:bg-blue-50 cursor-pointer transition flex justify-between items-center shadow-sm"
                    >
                      <span className="font-bold text-slate-800 text-sm truncate">{term.title}</span>
                      <span className="text-xs text-blue-600 font-bold shrink-0 ml-2">열기 &rarr;</span>
                    </div>
                  )
                })}
              </div>
              {recentSlugs.length === 0 && (
                <div className="p-4 bg-white border border-slate-200 rounded-xl text-center text-xs text-slate-400 italic shadow-sm">
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
              <div className="flex flex-col gap-3">
                {allTerms.map((term) => (
                  <div
                    key={term.id || term.slug}
                    onClick={() => fetchTermDetail(term.slug)}
                    className="p-4 bg-slate-50 hover:bg-blue-50 border border-slate-200 rounded-xl cursor-pointer transition flex justify-between items-center"
                  >
                    <div>
                      <h3 className="font-bold text-slate-800 text-lg">{term.title}</h3>
                      <span className="text-xs text-slate-400 font-mono">slug: {term.slug}</span>
                    </div>
                    <span className="text-xs text-blue-600 font-bold">읽기 &rarr;</span>
                  </div>
                ))}
                {allTerms.length === 0 && (
                  <p className="text-center text-slate-400 py-8">등록된 문서가 없습니다.</p>
                )}
              </div>
            </div>

            {/* 우측 그래프뷰 (sticky top-8 적용하여 스크롤 시 화면 고정) */}
            <div className="w-[372px] bg-white p-4 rounded-2xl shadow-sm border border-slate-200 flex flex-col items-center sticky top-8">
              <span className="text-xs font-bold text-slate-400 mb-2">그래프뷰</span>
              <div className="bg-slate-50 rounded-xl overflow-hidden border border-slate-100 cursor-grab active:cursor-grabbing">
                <svg ref={minimapRef} width="340" height="340" className="w-[340px] h-[340px]"></svg>
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
                        {selectedTerm.parent_slug && (
                          <span className="text-xs bg-blue-50 text-blue-600 font-mono px-2.5 py-1 rounded-md">
                            상위 노드: {selectedTerm.parent_slug}
                          </span>
                        )}
                      </div>
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
                    className="prose max-w-none text-slate-700 min-h-[400px] leading-relaxed text-base"
                    dangerouslySetInnerHTML={{ __html: selectedTerm.content || '<span class="text-slate-400 italic">작성된 내용이 없습니다. 수정 버튼을 눌러 내용을 채워보세요.</span>' }}
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
                          {editParentSlug ? `상위 노드: ${editParentSlug}` : '상위 노드 없음 (최상위)'}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setTempTitle(editTitle)
                          setTempParentSlug(editParentSlug)
                          const currentChildren = allTerms
                            .filter(t => (t.parent_slug || '').split(',').map(s => s.trim()).includes(editSlug))
                            .map(t => t.slug)
                          setTempChildSlugs(currentChildren)
                          setIsMetaParentOpen(true)
                          setIsMetaModalOpen(true)
                        }}
                        className="text-xs bg-slate-100 text-slate-700 font-bold px-3 py-1.5 rounded-xl hover:bg-slate-200 transition border border-slate-200"
                      >
                        제목/상위/하위노드 변경
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

                  <div className="flex flex-col flex-1 gap-2">
                    <div className="flex justify-between items-center">
                      <label className="block text-xs font-bold text-slate-500 uppercase">본문 내용</label>
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
                    <div
                      ref={editorRef}
                      contentEditable
                      suppressContentEditableWarning
                      onInput={(e) => setEditContent(e.currentTarget.innerHTML)}
                      onPaste={handlePaste}
                      className="w-full flex-1 bg-slate-50 border border-slate-300 rounded-xl p-4 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 font-sans leading-relaxed overflow-y-auto min-h-[550px]"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* 우측 그래프뷰 영역 (sticky top-8 적용하여 스크롤 시 화면 고정) */}
            <div className="w-[372px] bg-white p-4 rounded-2xl shadow-sm border border-slate-200 flex flex-col items-center sticky top-8">
              <span className="text-xs font-bold text-slate-400 mb-2">그래프뷰</span>
              <div className="bg-slate-50 rounded-xl overflow-hidden border border-slate-100 cursor-grab active:cursor-grabbing">
                <svg ref={minimapRef} width="340" height="340" className="w-[340px] h-[340px]"></svg>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* 새 문서 생성 모달 창 */}
      {isModalOpen && (
        <div 
          className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4"
          onKeyDown={handleModalKeyDown}
        >
          <div className="bg-white w-full max-w-md p-6 rounded-2xl shadow-2xl border border-slate-200 flex flex-col gap-4 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center border-b pb-3">
              <h3 className="text-lg font-bold text-slate-800">새 문서 기본 정보 입력</h3>
              <button
                onClick={() => setIsModalOpen(false)}
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
                  placeholder="문서 제목을 입력하세요"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl p-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  autoFocus
                  required
                />
              </div>

              {/* 상위 노드 선택 */}
              <div>
                <div 
                  onClick={() => setIsCreateParentOpen(!isCreateParentOpen)}
                  className="flex justify-between items-center cursor-pointer select-none mb-1 py-1"
                >
                  <label className="block text-xs font-bold text-slate-500 uppercase cursor-pointer">상위 노드 선택 (단일 선택)</label>
                  <span className="text-xs text-slate-400 font-bold">{isCreateParentOpen ? '▲' : '▼'}</span>
                </div>
                {isCreateParentOpen && (
                  <div className="bg-slate-50 border border-slate-300 rounded-xl p-3 max-h-32 overflow-y-auto flex flex-col gap-2">
                    <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                      <input
                        type="radio"
                        name="createParentGroup"
                        checked={!selectedParentSlug}
                        onChange={() => setSelectedParentSlug('')}
                        className="text-blue-600 focus:ring-blue-500"
                      />
                      <span>-- 상위 노드 없음 (최상위) --</span>
                    </label>
                    {allTerms.map((term) => (
                      <label key={term.slug} className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                        <input
                          type="radio"
                          name="createParentGroup"
                          value={term.slug}
                          checked={selectedParentSlug === term.slug}
                          onChange={() => setSelectedParentSlug(term.slug)}
                          className="text-blue-600 focus:ring-blue-500"
                        />
                        <span>{term.title} ({term.slug})</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {/* 하위 노드 선택 */}
              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">하위 노드 선택 (복수 선택 가능)</label>
                <div className="bg-slate-50 border border-slate-300 rounded-xl p-3 max-h-32 overflow-y-auto flex flex-col gap-2">
                  {allTerms.map((term) => (
                    <label key={term.slug} className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                      <input
                        type="checkbox"
                        value={term.slug}
                        checked={selectedChildSlugs.includes(term.slug)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedChildSlugs([...selectedChildSlugs, term.slug])
                          } else {
                            setSelectedChildSlugs(selectedChildSlugs.filter(s => s !== term.slug))
                          }
                        }}
                        className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                      />
                      <span>{term.title} ({term.slug})</span>
                    </label>
                  ))}
                  {allTerms.length === 0 && (
                    <span className="text-xs text-slate-400">선택 가능한 문서가 없습니다.</span>
                  )}
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

      {/* 작성 페이지 내 제목/상위노드/하위노드 편집 모달 */}
      {isMetaModalOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white w-full max-w-md p-6 rounded-2xl shadow-2xl border border-slate-200 flex flex-col gap-4 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center border-b pb-3">
              <h3 className="text-lg font-bold text-slate-800">제목 및 상위/하위 노드 변경</h3>
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

              {/* 상위 노드 선택 */}
              <div>
                <div 
                  onClick={() => setIsMetaParentOpen(!isMetaParentOpen)}
                  className="flex justify-between items-center cursor-pointer select-none mb-1 py-1"
                >
                  <label className="block text-xs font-bold text-slate-500 uppercase cursor-pointer">상위 노드 선택 (단일 선택)</label>
                  <span className="text-xs text-slate-400 font-bold">{isMetaParentOpen ? '▲' : '▼'}</span>
                </div>
                {isMetaParentOpen && (
                  <div className="bg-slate-50 border border-slate-300 rounded-xl p-3 max-h-32 overflow-y-auto flex flex-col gap-2">
                    <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                      <input
                        type="radio"
                        name="metaParentGroup"
                        checked={!tempParentSlug}
                        onChange={() => setTempParentSlug('')}
                        className="text-blue-600 focus:ring-blue-500"
                      />
                      <span>-- 상위 노드 없음 (최상위) --</span>
                    </label>
                    {allTerms
                      .filter(t => t.slug !== editSlug)
                      .map((term) => (
                        <label key={term.slug} className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                          <input
                            type="radio"
                            name="metaParentGroup"
                            value={term.slug}
                            checked={tempParentSlug === term.slug}
                            onChange={() => setTempParentSlug(term.slug)}
                            className="text-blue-600 focus:ring-blue-500"
                          />
                          <span>{term.title} ({term.slug})</span>
                        </label>
                      ))}
                  </div>
                )}
              </div>

              {/* 하위 노드 선택 */}
              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">하위 노드 선택 (복수 선택 가능)</label>
                <div className="bg-slate-50 border border-slate-300 rounded-xl p-3 max-h-32 overflow-y-auto flex flex-col gap-2">
                  {allTerms
                    .filter(t => t.slug !== editSlug)
                    .map((term) => (
                      <label key={term.slug} className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                        <input
                          type="checkbox"
                          value={term.slug}
                          checked={tempChildSlugs.includes(term.slug)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setTempChildSlugs([...tempChildSlugs, term.slug])
                            } else {
                              setTempChildSlugs(tempChildSlugs.filter(s => s !== term.slug))
                            }
                          }}
                          className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                        />
                        <span>{term.title} ({term.slug})</span>
                      </label>
                    ))}
                  {allTerms.filter(t => t.slug !== editSlug).length === 0 && (
                    <span className="text-xs text-slate-400">선택 가능한 문서가 없습니다.</span>
                  )}
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
                      alert("제목을 입력해주세요.")
                      return
                    }
                    setEditTitle(tempTitle)
                    setEditParentSlug(tempParentSlug)
                    await updateChildRelations(editSlug, tempChildSlugs)
                    await fetchData()
                    setIsMetaModalOpen(false)
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
    </div>
  )
}