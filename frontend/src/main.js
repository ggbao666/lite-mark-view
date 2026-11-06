import './style.css'
import { EditorView, keymap, Decoration } from '@codemirror/view'
import { EditorState, StateEffect, StateField, Prec } from '@codemirror/state'
import {
  history,
  defaultKeymap,
  historyKeymap,
  indentWithTab,
  toggleComment,
} from '@codemirror/commands'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { tags as t } from '@lezer/highlight'
import {
  createEditor,
  getMarkdown,
  setMarkdown,
  countWords,
  setSearchHighlight,
} from './editor.js'

// ---------- Wails 运行时绑定（wails dev / build 时由桥接注入） ----------
const wails = () => window.go?.main?.App

// ---------- DOM ----------
const $ = (id) => document.getElementById(id)
const elTitle = $('file-title')
const elModeBtn = $('btn-mode')
const elWords = $('status-words')
const elMode = $('status-mode')
const elDirty = $('status-dirty')
const elPath = $('status-path')
const elReveal = $('status-reveal')
const elTiptapWrap = $('tiptap-editor')
const elSourceWrap = $('source-wrap')
const elSource = $('source-editor')

// ---------- 状态 ----------
let currentPath = '' // 显示用文件路径
let dirty = false
let mode = 'wysiwyg' // 'wysiwyg' | 'source'
let docOpen = false // 是否已进入编辑状态（新建/打开后为 true，启动页不再出现）
let rawMarkdown = '' // 打开/保存时的文件原文（源码模式直接显示它，不做序列化转换）
let wysiwygEdited = false // 所见即所得里是否改过内容
let sourceDirty = false // 源码模式里是否改过内容（切回时需要重新解析）

function baseName(p) {
  if (!p) return '未命名'
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return i >= 0 ? p.slice(i + 1) : p
}

// 标题栏显示用文件名（隐藏 .md 扩展名）
function displayName(p) {
  return baseName(p).replace(/\.(md|markdown)$/i, '')
}

function dirName(p) {
  if (!p) return ''
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return i > 0 ? p.slice(0, i) : ''
}

function refreshHeader() {
  elTitle.textContent = displayName(currentPath) + (dirty ? ' ●' : '')
  elTitle.title = currentPath ? '点击重命名' : ''
  elDirty.textContent = dirty ? '未保存' : '已保存'
  // 状态栏显示文件所在目录；未命名/未保存时不显示
  const dir = dirName(currentPath)
  elPath.textContent = dir
  elPath.title = dir
  // 有真实文件路径时才显示「打开所在目录」
  elReveal.classList.toggle('hidden', !currentPath)
}

// ---------- 标题栏点击重命名 ----------
let renaming = false

async function startRename() {
  if (renaming) return
  if (!currentPath) {
    elDirty.textContent = '请先保存文件后再重命名'
    return
  }
  renaming = true

  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'title-input'
  input.value = displayName(currentPath)
  elTitle.textContent = ''
  elTitle.appendChild(input)
  input.focus()
  input.select()

  let done = false
  const finish = async (commit) => {
    if (done) return
    done = true
    const val = input.value.trim()
    elTitle.textContent = ''
    renaming = false

    if (commit && val && val !== displayName(currentPath)) {
      const app = wails()
      if (app) {
        try {
          const newPath = await app.RenameFile(val)
          if (newPath) currentPath = newPath
        } catch (e) {
          alert('重命名失败: ' + e)
        }
      }
    }
    refreshHeader()
    if (!commit) editor.commands.focus()
  }

  input.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter') {
      e.preventDefault()
      finish(true)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      finish(false)
    }
  })
  input.addEventListener('blur', () => finish(true))
  // 点击输入框内不触发外层点击
  input.addEventListener('click', (e) => e.stopPropagation())
}

elTitle.addEventListener('click', startRename)

function refreshStats(md) {
  elWords.textContent = `${countWords(md)} 字`
}

function markDirty() {
  if (!dirty) {
    dirty = true
    refreshHeader()
  }
  scheduleAutoSave()
}

// ---------- 自动保存（防抖 2s，仅用于已命名的文件） ----------
let autoSaveTimer = null

function scheduleAutoSave() {
  clearTimeout(autoSaveTimer)
  autoSaveTimer = setTimeout(autoSave, 2000)
}

function nowTime() {
  return new Date().toTimeString().slice(0, 5)
}

async function autoSave() {
  const app = wails()
  if (!app) return
  if (!currentPath) return // 未命名文档不自动保存；关闭时询问「保留 / 废弃」
  try {
    const md = currentMarkdown()
    await app.SaveMarkdown(md)
    rawMarkdown = md
    if (mode === 'wysiwyg' && lastMarkdown === md) wysiwygEdited = false
    dirty = false
    refreshHeader()
    elDirty.textContent = `已自动保存 ${nowTime()}`
  } catch (e) {
    console.error('自动保存失败', e)
  }
}

// ---------- 图片上传（落盘到 Go 端，按设置决定位置） ----------
async function uploadImage(file) {
  const app = wails()
  if (!app) return null
  const dataURL = await new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result)
    r.onerror = reject
    r.readAsDataURL(file)
  })
  return app.SaveImage(file.name, dataURL)
}

// ---------- Tiptap ----------
// 最近一次内容；链接展开成原文等视图层变化不改变 Markdown，不应标记为已修改
let lastMarkdown = ''

const editor = createEditor(elTiptapWrap, {
  onUpdate: (md) => {
    if (md === lastMarkdown) return
    lastMarkdown = md
    wysiwygEdited = true
    markDirty()
    refreshStats(md)
    refreshOutline()
  },
  getCurrentDir: () => dirName(currentPath),
  uploadImage,
  downloadImage: (url) => wails()?.DownloadImage(url),
  // 仅所见即所得模式下自动把 [名称](地址) 转成链接
  canAutoConvert: () => mode === 'wysiwyg',
})

// 编辑区滚动容器（注意：$ 是 getElementById 的简写，此处须用 querySelector）
const editorScrollWrap = document.querySelector('.editor-wrap')

// ---------- 源码模式：CodeMirror 6（显示文件原文） ----------
// 不做实时同步进 tiptap：源码里改过，切回所见即所得时再用原文重新解析，
// 保证解析结果与文件原文完全一致。

// Markdown / 围栏代码块的语法高亮配色：直接用全局 CSS 变量，亮暗主题自动跟随
const cmHighlight = HighlightStyle.define([
  { tag: t.heading, color: 'var(--hl-title)', fontWeight: 'bold' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--accent)' },
  { tag: t.url, color: 'var(--accent)' },
  { tag: t.monospace, color: 'var(--hl-string)' },
  { tag: t.quote, color: 'var(--quote-fg)' },
  { tag: t.processingInstruction, color: 'var(--fg-soft)' }, // #、**、``` 等记号
  { tag: t.contentSeparator, color: 'var(--fg-soft)' }, // ---
  { tag: t.meta, color: 'var(--fg-soft)' },
  { tag: t.keyword, color: 'var(--hl-keyword)' },
  { tag: t.atom, color: 'var(--hl-builtin)' },
  { tag: t.string, color: 'var(--hl-string)' },
  { tag: t.number, color: 'var(--hl-number)' },
  { tag: t.comment, color: 'var(--hl-comment)' },
  { tag: t.variableName, color: 'var(--hl-attr)' },
  { tag: t.typeName, color: 'var(--hl-builtin)' },
  { tag: t.propertyName, color: 'var(--hl-attr)' },
  { tag: t.labelName, color: 'var(--hl-builtin)' },
])

// 查找匹配的 CM 装饰层（find-mark / find-mark-active）
const setFindEffect = StateEffect.define()
const findField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const e of tr.effects) if (e.is(setFindEffect)) deco = e.value
    return deco
  },
  provide: (f) => EditorView.decorations.from(f),
})

let sourceProgrammatic = false // 程序性改写（切模式/载入文件）不算源码编辑

// Ctrl+/ 在本应用里统一表示「切换源码模式 / 所见即所得」。
// CodeMirror 的 defaultKeymap 把 Mod-/ 绑成了 toggleComment：源码模式下按 Ctrl+/
// 会先往正文插 <!-- … --> 注释，而 window 上的全局快捷键又同时切了模式，
// 表现为「按切换键却插入注释」。这里摘掉默认绑定，换成最高优先级的模式切换；
// stopPropagation 防止事件冒泡到 window 再切一次（切两次等于没切）。
const cmKeymapWithoutComment = defaultKeymap.filter((b) => b.key !== 'Mod-/')
const cmModeKeys = Prec.highest(
  keymap.of([
    {
      key: 'Mod-/',
      stopPropagation: true,
      run: () => {
        toggleEditorMode()
        return true
      },
    },
  ]),
)

const cmView = new EditorView({
  parent: elSource,
  state: EditorState.create({
    doc: '',
    extensions: [
      history(),
      cmModeKeys,
      keymap.of([...cmKeymapWithoutComment, ...historyKeymap, indentWithTab]),
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      syntaxHighlighting(cmHighlight),
      EditorView.lineWrapping,
      EditorState.tabSize.of(2),
      findField,
      EditorView.updateListener.of((u) => {
        if (!u.docChanged || sourceProgrammatic) return
        scheduleFindRefresh()
        sourceDirty = true
        markDirty()
        refreshStats(getSourceText())
        refreshOutline()
      }),
    ],
  }),
})

function getSourceText() {
  return cmView.state.doc.toString()
}

function setSourceText(text) {
  const cur = getSourceText()
  if (cur === text) return
  sourceProgrammatic = true
  cmView.dispatch({ changes: { from: 0, to: cur.length, insert: text } })
  sourceProgrammatic = false
}

// 把查找匹配刷进 CM 装饰层
function renderSourceHighlight() {
  const ranges = []
  const len = cmView.state.doc.length
  if (findBarOpen()) {
    for (let i = 0; i < findMatches.length; i += 1) {
      const m = findMatches[i]
      if (m.from >= len) break
      const cls = i === findActive ? 'find-mark find-mark-active' : 'find-mark'
      ranges.push(Decoration.mark({ class: cls }).range(m.from, Math.min(m.to, len)))
    }
  }
  cmView.dispatch({ effects: setFindEffect.of(Decoration.set(ranges, true)) })
}

// 把源码的某个字符位置滚到页面可视区约 1/3 处
function scrollSourceOffsetTo(offset, ratio = 1 / 3) {
  const wrap = editorScrollWrap
  if (!wrap) return
  const coords = cmView.coordsAtPos(Math.min(offset, cmView.state.doc.length))
  if (!coords) return
  const wrapRect = wrap.getBoundingClientRect()
  wrap.scrollTop = Math.max(
    0,
    wrap.scrollTop + (coords.top - wrapRect.top) - wrap.clientHeight * ratio,
  )
}

// ---------- 源码行 ↔ 所见即所得块 的近似映射 ----------
// 每个块记录它在文件文本里的起始行；切换模式时据此把光标放到对应/附近行
let blockLineMap = [] // [{ pos, node, line }]

function buildBlockLineMap(markdown, doc) {
  const srcLines = markdown.split('\n')
  const blocks = []
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      blocks.push({ pos, node, text: (node.textContent || '').trim() })
      return false
    }
    return true
  })
  const map = []
  let searchFrom = 0
  for (const block of blocks) {
    const first = block.text.split('\n')[0].trim().slice(0, 60)
    let line = -1
    if (first) {
      for (let i = searchFrom; i < srcLines.length; i += 1) {
        if (srcLines[i].includes(first)) {
          line = i
          break
        }
      }
      if (line < 0) {
        for (let i = 0; i < srcLines.length; i += 1) {
          if (srcLines[i].includes(first)) {
            line = i
            break
          }
        }
      }
    }
    if (line < 0) line = Math.min(searchFrom, Math.max(0, srcLines.length - 1))
    else searchFrom = line
    map.push({ pos: block.pos, node: block.node, line })
  }
  return map
}

// 光标文档位置 → 源码行（代码块按块内换行数偏移）
function sourceLineAt(pos) {
  if (!blockLineMap.length) return 0
  let entry = blockLineMap[0]
  for (const item of blockLineMap) {
    if (item.pos <= pos) entry = item
    else break
  }
  let line = entry.line
  if (entry.node?.type?.name === 'codeBlock') {
    const before = entry.node.textContent.slice(0, Math.max(0, pos - (entry.pos + 1)))
    line += (before.match(/\n/g) || []).length
  }
  return line
}

// 源码行 → 文档位置（放进对应块里）
function docPosAtLine(line) {
  if (!blockLineMap.length) return 1
  let entry = blockLineMap[0]
  for (const item of blockLineMap) {
    if (item.line <= line) entry = item
    else break
  }
  let pos = entry.pos + 1
  if (entry.node?.type?.name === 'codeBlock') {
    const codeLines = entry.node.textContent.split('\n')
    const offset = Math.max(0, Math.min(line - entry.line, codeLines.length - 1))
    for (let i = 0; i < offset; i += 1) pos += codeLines[i].length + 1
  }
  return Math.min(pos, editor.state.doc.content.size)
}

function sourceCaretLine() {
  const head = cmView.state.selection.main.head
  return cmView.state.doc.lineAt(head).number - 1
}

// 切换模式时的定位锚点：取视口约 1/3 处正在看的内容，而不是光标位置
// （光标可能停在很上面，但人已经滚到下面看了）
function wysiwygViewportAnchorPos() {
  const wrap = editorScrollWrap
  if (!wrap) return editor.state.selection.from
  const r = wrap.getBoundingClientRect()
  const hit = editor.view.posAtCoords({
    left: r.left + r.width / 2,
    top: r.top + r.height / 3,
  })
  return hit ? hit.pos : editor.state.selection.from
}

function sourceViewportLine() {
  const wrap = editorScrollWrap
  if (!wrap) return sourceCaretLine()
  const r = wrap.getBoundingClientRect()
  const pos = cmView.posAtCoords({
    x: r.left + r.width / 2,
    y: r.top + r.height / 3,
  })
  if (pos == null) return sourceCaretLine()
  return cmView.state.doc.lineAt(pos).number - 1
}

// 源码模式：把光标放到对应行，并滚到可视区约 1/3 处
function placeSourceCaret(line) {
  const doc = cmView.state.doc
  const target = Math.max(1, Math.min(line + 1, doc.lines))
  const offset = doc.line(target).from
  cmView.focus()
  cmView.dispatch({ selection: { anchor: offset } })
  requestAnimationFrame(() => scrollSourceOffsetTo(offset))
}

// 所见即所得：滚动到光标处，放在可视区约 1/3 位置
function scrollCaretToThird() {
  const wrap = editorScrollWrap
  if (!wrap) return
  requestAnimationFrame(() => {
    let rect = null
    try {
      const sel = window.getSelection()
      if (sel && sel.rangeCount) rect = sel.getRangeAt(0).getBoundingClientRect()
    } catch {
      rect = null
    }
    if (!rect || (!rect.height && !rect.top)) {
      try {
        const res = editor.view.domAtPos(editor.state.selection.from)
        const el = res.node.nodeType === 1 ? res.node : res.node.parentElement
        rect = el?.getBoundingClientRect() || null
      } catch {
        rect = null
      }
    }
    if (!rect) return
    const wrapRect = wrap.getBoundingClientRect()
    wrap.scrollTop = Math.max(
      0,
      wrap.scrollTop + (rect.top - wrapRect.top) - wrapRect.height / 3,
    )
  })
}

// Ctrl+/ 的统一入口：源码模式由 CodeMirror 的高优先级键位调用，其它场景由
// window 上的全局快捷键调用。启动页 / 有模态框时不响应，避免切到看不见的源码视图。
function toggleEditorMode() {
  if (!docOpen || hasOpenModal()) return
  setMode(mode === 'wysiwyg' ? 'source' : 'wysiwyg')
}

// ---------- 模式切换 ----------
function setMode(next) {
  if (next === mode) return
  if (next === 'source') {
    // 没有改过所见即所得 → 直接显示打开/保存时的文件原文，避免序列化改写
    let text = rawMarkdown
    if (wysiwygEdited) {
      text = getMarkdown(editor)
      rawMarkdown = text
      wysiwygEdited = false
    }
    // 先记住视口 1/3 处在原文中的行，再切过去
    blockLineMap = buildBlockLineMap(text, editor.state.doc)
    const caretLine = sourceLineAt(wysiwygViewportAnchorPos())
    mode = 'source'
    document.body.classList.add('source-mode')
    setSourceText(text)
    sourceDirty = false
    elTiptapWrap.classList.add('hidden')
    elSourceWrap.classList.remove('hidden')
    elMode.textContent = '源码模式'
    placeSourceCaret(caretLine)
  } else {
    // 记住源码里视口 1/3 处的行；源码改过就用原文重新解析，保证所见即所得准确
    const line = sourceViewportLine()
    const text = getSourceText()
    mode = 'wysiwyg'
    document.body.classList.remove('source-mode')
    if (sourceDirty) {
      loadContent(text)
    } else {
      blockLineMap = buildBlockLineMap(text, editor.state.doc)
    }
    elSourceWrap.classList.add('hidden')
    elTiptapWrap.classList.remove('hidden')
    elMode.textContent = '所见即所得'
    try {
      editor.chain().focus().setTextSelection(docPosAtLine(line)).run()
    } catch {
      editor.commands.focus()
    }
    scrollCaretToThird()
  }
  // 按钮始终保持 SVG 图标，只切换高亮状态与提示文字
  elModeBtn.classList.toggle('active', mode === 'source')
  elModeBtn.title =
    mode === 'source'
      ? '切换到所见即所得 (Ctrl+/)'
      : '切换到源码模式 (Ctrl+/)'
  // 切换后按当前模式的文本重建大纲（源码模式按纯文本里的 # 行）
  refreshOutline()
  if (findBarOpen()) computeFindMatches(0)
}

elModeBtn.addEventListener('click', toggleEditorMode)

// ---------- 查找 / 替换 ----------
// 两种模式共用同一个面板：所见即所得用 ProseMirror 装饰高亮，源码模式用 CodeMirror 装饰
const findBar = $('findbar')
const findInput = $('find-input')
const findCount = $('find-count')
const replaceRow = $('find-replace-row')
const replaceInput = $('replace-input')
const btnFindCase = $('find-case')
const btnFindWord = $('find-word')
const btnFindRegex = $('find-regex')
const btnFindShowReplace = $('find-show-replace')
const btnFindPrev = $('find-prev')
const btnFindNext = $('find-next')
const btnReplaceOne = $('replace-one')
const btnReplaceAll = $('replace-all')

const findOptions = { caseSensitive: false, wholeWord: false, regex: false }
let findMatches = [] // [{from,to}]
let findActive = -1
let findRefreshTimer = null

function findBarOpen() {
  return !findBar.classList.contains('hidden')
}

function caretPos() {
  return mode === 'source'
    ? cmView.state.selection.main.head
    : editor.state.selection.from
}

// 所见即所得：按文本块拼接文字，记录每个字符对应的文档位置
// （同一段落里的加粗/斜体等会把文本拆成多个节点，这里要把它们拼回去）
function wysiwygSearchBlocks() {
  const blocks = []
  let cur = null
  editor.state.doc.descendants((node, pos) => {
    if (node.isTextblock) {
      cur = { text: '', pos: [] }
      blocks.push(cur)
      return true
    }
    if (node.isText && cur) {
      const text = node.text || ''
      cur.text += text
      for (let i = 0; i < text.length; i += 1) cur.pos.push(pos + i)
    }
    return true
  })
  return blocks
}

function buildSearchRegex(query) {
  let src = findOptions.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (findOptions.wholeWord) {
    src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`
  }
  try {
    return new RegExp(src, 'g' + (findOptions.caseSensitive ? '' : 'i') + 'u')
  } catch {
    return null
  }
}

function applyFindHighlights() {
  if (!findBarOpen()) return
  if (mode === 'source') {
    renderSourceHighlight()
    return
  }
  setSearchHighlight(editor, findMatches, findActive)
}

function updateFindUI() {
  const has = findMatches.length > 0
  findCount.classList.remove('bad')
  if (!findInput.value) findCount.textContent = '0/0'
  else if (has) findCount.textContent = `${findActive + 1}/${findMatches.length}`
  else findCount.textContent = '无结果'
  btnFindPrev.disabled = !has
  btnFindNext.disabled = !has
  btnReplaceOne.disabled = !has
  btnReplaceAll.disabled = !has
  applyFindHighlights()
}

function computeFindMatches(anchor) {
  const query = findInput.value
  findMatches = []
  findActive = -1
  if (!query) {
    updateFindUI()
    return
  }
  const re = buildSearchRegex(query)
  if (!re) {
    findCount.textContent = '正则无效'
    findCount.classList.add('bad')
    btnFindPrev.disabled = true
    btnFindNext.disabled = true
    btnReplaceOne.disabled = true
    btnReplaceAll.disabled = true
    applyFindHighlights()
    return
  }
  if (mode === 'source') {
    const text = getSourceText()
    let m
    while ((m = re.exec(text))) {
      if (!m[0].length) {
        re.lastIndex += 1
        continue
      }
      findMatches.push({ from: m.index, to: m.index + m[0].length })
    }
  } else {
    for (const block of wysiwygSearchBlocks()) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(block.text))) {
        if (!m[0].length) {
          re.lastIndex += 1
          continue
        }
        findMatches.push({
          from: block.pos[m.index],
          to: block.pos[m.index + m[0].length - 1] + 1,
        })
      }
    }
  }
  if (findMatches.length) {
    const idx = findMatches.findIndex((m) => m.from >= (anchor ?? 0))
    findActive = idx >= 0 ? idx : 0
  }
  updateFindUI()
}

function scheduleFindRefresh() {
  if (!findBarOpen()) return
  clearTimeout(findRefreshTimer)
  findRefreshTimer = setTimeout(() => {
    if (!findBarOpen()) return
    computeFindMatches(caretPos())
  }, 0)
}

// 源码模式：选中匹配处并滚到可视区约 1/3；不抢查找框焦点（否则没法继续输入）
function revealSourceRange(from, to) {
  cmView.dispatch({ selection: { anchor: from, head: to } })
  scrollSourceOffsetTo(from)
}

function scrollToActiveMatch() {
  const m = findMatches[findActive]
  if (!m) return
  if (mode === 'source') {
    revealSourceRange(m.from, m.to)
    return
  }
  // 不抢查找框焦点，也不改编辑区选区（避免气泡菜单弹出），只滚动到匹配处
  try {
    const res = editor.view.domAtPos(m.from)
    const el = res.node.nodeType === 1 ? res.node : res.node.parentElement
    el?.scrollIntoView({ block: 'center' })
  } catch {
    /* 位置可能已失效 */
  }
}

function stepFind(dir) {
  if (!findMatches.length) return
  const n = findMatches.length
  findActive = ((findActive + dir) % n + n) % n
  updateFindUI()
  scrollToActiveMatch()
}

function openFind(withReplace = false) {
  const firstOpen = !findBarOpen()
  findBar.classList.remove('hidden')
  replaceRow.classList.toggle('hidden', !withReplace)
  btnFindShowReplace.classList.toggle('active', withReplace)
  if (firstOpen) {
    // 有选中文字时把它作为查找词（和主流所见即所得编辑器一致）
    try {
      let selected = ''
      if (mode === 'source') {
        const sel = cmView.state.selection.main
        selected = getSourceText().slice(sel.from, sel.to)
      } else {
        const sel = editor.state.selection
        if (sel.from !== sel.to) {
          selected = editor.state.doc.textBetween(sel.from, sel.to, '\n')
        }
      }
      if (selected && selected.length <= 500 && !selected.includes('\n')) {
        findInput.value = selected
      }
    } catch {
      /* 选区不合法，忽略 */
    }
  }
  findInput.focus()
  findInput.select()
  computeFindMatches(caretPos())
}

function closeFind() {
  clearTimeout(findRefreshTimer)
  findBar.classList.add('hidden')
  findMatches = []
  findActive = -1
  if (mode === 'source') {
    renderSourceHighlight()
    cmView.focus()
  } else {
    setSearchHighlight(editor, [], -1)
    editor.commands.focus()
  }
}

function replaceOnce() {
  const m = findMatches[findActive]
  if (!m) return
  const rep = replaceInput.value
  const anchor = m.from + rep.length
  if (mode === 'source') {
    // 更新监听器会自动标脏/刷新统计与大纲
    cmView.dispatch({
      changes: { from: m.from, to: m.to, insert: rep },
      selection: { anchor },
    })
  } else {
    editor.view.dispatch(editor.state.tr.insertText(rep, m.from, m.to))
  }
  computeFindMatches(anchor)
  scrollToActiveMatch()
}

function replaceEvery() {
  if (!findMatches.length) return
  const rep = replaceInput.value
  if (mode === 'source') {
    // findMatches 本身是升序的，CM 一次性原子替换
    cmView.dispatch({
      changes: findMatches.map((m) => ({ from: m.from, to: m.to, insert: rep })),
    })
  } else {
    const tr = editor.state.tr
    for (let i = findMatches.length - 1; i >= 0; i -= 1) {
      tr.insertText(rep, findMatches[i].from, findMatches[i].to)
    }
    editor.view.dispatch(tr)
  }
  computeFindMatches(0)
}

$('btn-find').addEventListener('click', () => {
  if (findBarOpen()) closeFind()
  else openFind(false)
})
$('find-close').addEventListener('click', closeFind)
btnFindPrev.addEventListener('click', () => stepFind(-1))
btnFindNext.addEventListener('click', () => stepFind(1))
btnReplaceOne.addEventListener('click', replaceOnce)
btnReplaceAll.addEventListener('click', replaceEvery)

function toggleFindOption(key, btn) {
  findOptions[key] = !findOptions[key]
  btn.classList.toggle('active', findOptions[key])
  computeFindMatches(caretPos())
  findInput.focus()
}
btnFindCase.addEventListener('click', () => toggleFindOption('caseSensitive', btnFindCase))
btnFindWord.addEventListener('click', () => toggleFindOption('wholeWord', btnFindWord))
btnFindRegex.addEventListener('click', () => toggleFindOption('regex', btnFindRegex))

btnFindShowReplace.addEventListener('click', () => {
  const show = replaceRow.classList.contains('hidden')
  replaceRow.classList.toggle('hidden', !show)
  btnFindShowReplace.classList.toggle('active', show)
  if (show) replaceInput.focus()
  else findInput.focus()
})

findInput.addEventListener('input', () => computeFindMatches(caretPos()))
findInput.addEventListener('keydown', (e) => {
  e.stopPropagation()
  if (e.key === 'Enter') {
    e.preventDefault()
    stepFind(e.shiftKey ? -1 : 1)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    closeFind()
  } else if (e.ctrlKey && e.key.toLowerCase() === 'h') {
    e.preventDefault()
    replaceRow.classList.remove('hidden')
    btnFindShowReplace.classList.add('active')
    replaceInput.focus()
  }
})
replaceInput.addEventListener('keydown', (e) => {
  e.stopPropagation()
  if (e.key === 'Enter') {
    e.preventDefault()
    replaceOnce()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    closeFind()
  }
})

// 文档变化后刷新匹配（不抢焦点、不重排光标）
editor.on('transaction', ({ transaction }) => {
  if (transaction.docChanged) scheduleFindRefresh()
})

// 表格：标题栏插入 + 表格内右键菜单
$('tb-insert').addEventListener('click', () => {
  editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
})

// ---------- 插入链接：[链接名称](链接地址) ----------
const linkOverlay = $('link-overlay')
const linkTextInput = $('link-text')
const linkUrlInput = $('link-url')
let linkRange = null // 打开弹窗时的选区（弹窗期间编辑器会失焦）

function openLinkDialog() {
  const { from, to } = editor.state.selection
  const selected = from !== to ? editor.state.doc.textBetween(from, to, ' ') : ''
  linkRange = { from, to }
  linkTextInput.value = selected
  linkUrlInput.value = ''
  linkOverlay.classList.remove('hidden')
  // 已有选中文字时名称已填好，直接输入地址
  ;(selected ? linkUrlInput : linkTextInput).focus()
}

function closeLinkDialog() {
  linkOverlay.classList.add('hidden')
  linkTextInput.value = ''
  linkUrlInput.value = ''
  linkRange = null
}

function insertLink() {
  const url = linkUrlInput.value.trim()
  if (!url) {
    linkUrlInput.focus()
    return
  }
  // 名称为空时用地址代替
  const text = linkTextInput.value.trim() || url
  const sel = linkRange
  closeLinkDialog()
  const chain = editor.chain().focus()
  if (sel) chain.setTextSelection(sel)
  // 有选区时替换选中内容；无选区时插入到光标处
  chain
    .insertContent({
      type: 'text',
      text,
      marks: [{ type: 'link', attrs: { href: url } }],
    })
    .run()
  editor.commands.focus()
}

$('tb-link').addEventListener('click', openLinkDialog)
$('btn-link-cancel').addEventListener('click', closeLinkDialog)
$('btn-link-ok').addEventListener('click', insertLink)
for (const input of [linkTextInput, linkUrlInput]) {
  input.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter') {
      e.preventDefault()
      insertLink()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closeLinkDialog()
    }
  })
}
// 模态：点遮罩不关闭，Esc 关闭（避免误操作背后内容）
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !linkOverlay.classList.contains('hidden')) closeLinkDialog()
})

// 判断文档坐标 pos 是否位于表格内
function posInsideTable(pos) {
  const $pos = editor.state.doc.resolve(pos)
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type.name === 'table') return true
  }
  return false
}

// 构建右键菜单项（光标已在表格内）
function tableMenuItems() {
  const chain = () => editor.chain().focus()
  return [
    { label: '上方插入行', run: () => chain().addRowBefore().run() },
    { label: '下方插入行', run: () => chain().addRowAfter().run() },
    { label: '删除行', run: () => chain().deleteRow().run() },
    { sep: true },
    { label: '左侧插入列', run: () => chain().addColumnBefore().run() },
    { label: '右侧插入列', run: () => chain().addColumnAfter().run() },
    { label: '删除列', run: () => chain().deleteColumn().run() },
    { sep: true },
    { label: '删除表格', danger: true, run: () => chain().deleteTable().run() },
  ]
}

// 右键菜单 DOM（懒创建）
const ctxMenu = document.createElement('div')
ctxMenu.className = 'ctx-menu hidden'
document.body.appendChild(ctxMenu)

function hideCtxMenu() {
  ctxMenu.classList.add('hidden')
}

// 通用右键菜单：items = [{label, run, danger} | {sep}]
function showMenu(x, y, items) {
  ctxMenu.innerHTML = ''
  for (const item of items) {
    if (item.sep) {
      const sep = document.createElement('div')
      sep.className = 'ctx-sep'
      ctxMenu.appendChild(sep)
      continue
    }
    const btn = document.createElement('button')
    btn.textContent = item.label
    if (item.danger) btn.classList.add('danger')
    btn.addEventListener('click', () => {
      hideCtxMenu()
      item.run()
    })
    ctxMenu.appendChild(btn)
  }
  ctxMenu.classList.remove('hidden')
  // 边界处理：不让菜单超出窗口
  const rect = ctxMenu.getBoundingClientRect()
  ctxMenu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px'
  ctxMenu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px'
}

// 从 DOM img 元素反解磁盘绝对路径；非本地图片返回 null
function imageDiskPath(img) {
  const src = img.getAttribute('src') || ''
  if (src.startsWith('/local-file?path=')) {
    try {
      return new URL(src, location.origin).searchParams.get('path')
    } catch {
      return null
    }
  }
  return null
}

function imageMenuItems(diskPath) {
  return [
    {
      label: '查看图片',
      run: () => wails()?.ViewImage(diskPath).catch((e) => alert('打开查看器失败: ' + e)),
    },
    {
      label: '打开图片所在目录',
      run: () => wails()?.RevealInExplorer(diskPath).catch((e) => alert('打开目录失败: ' + e)),
    },
  ]
}

// 右键：图片 > 表格 > 系统默认菜单
elTiptapWrap.addEventListener('contextmenu', (e) => {
  // 1) 图片上右键
  const imgEl = e.target.closest('img')
  if (imgEl) {
    const diskPath = imageDiskPath(imgEl)
    if (diskPath) {
      e.preventDefault()
      showMenu(e.clientX, e.clientY, imageMenuItems(diskPath))
      return
    }
    return // 网络图片无磁盘路径，保持系统菜单
  }
  // 2) 表格内右键
  const hit = editor.view.posAtCoords({ left: e.clientX, top: e.clientY })
  if (!hit || !posInsideTable(hit.pos)) return
  e.preventDefault()
  // 把光标移动到右键位置，使行/列命令作用于点击处的表格
  editor.chain().focus().setTextSelection(hit.pos).run()
  showMenu(e.clientX, e.clientY, tableMenuItems())
})

// 点击菜单外或按 Esc 关闭
window.addEventListener('pointerdown', (e) => {
  if (!ctxMenu.classList.contains('hidden') && !ctxMenu.contains(e.target)) {
    hideCtxMenu()
  }
})
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideCtxMenu()
})

// 右键菜单（表格/图片）滚动时关闭：fixed 定位不跟随内容滚动，滞留会错位
const hideCtxMenuOnScroll = () => hideCtxMenu()
editorScrollWrap?.addEventListener('scroll', hideCtxMenuOnScroll, { passive: true })
window.addEventListener('wheel', hideCtxMenuOnScroll, { passive: true })

// ---------- 右侧目录大纲（默认折叠） ----------
const outlinePanel = $('outline-panel')
const outlineList = $('outline-list')
let outlineOpen = false

function toggleOutline(open) {
  outlineOpen = open ?? !outlineOpen
  outlinePanel.classList.toggle('open', outlineOpen)
  $('btn-outline').classList.toggle('active', outlineOpen)
}

$('btn-outline').addEventListener('click', () => toggleOutline())
$('btn-outline-close').addEventListener('click', () => toggleOutline(false))

// 大纲：所见即所得从文档结构取，源码模式从纯文本按行取
function refreshOutline() {
  const items = mode === 'source' ? sourceOutlineItems() : docOutlineItems()
  outlineList.innerHTML = ''
  if (!items.length) {
    const empty = document.createElement('div')
    empty.className = 'outline-empty'
    empty.textContent = '暂无标题'
    outlineList.appendChild(empty)
    return
  }
  for (const it of items) {
    const btn = document.createElement('button')
    btn.className = `outline-item lv-${it.level}`
    btn.textContent = it.text || '(空标题)'
    btn.title = it.text
    btn.addEventListener('click', () => jumpToHeading(it))
    outlineList.appendChild(btn)
  }
}

function docOutlineItems() {
  const items = []
  editor.state.doc.forEach((node, offset) => {
    if (node.type.name === 'heading') {
      items.push({ level: node.attrs.level, text: node.textContent, pos: offset })
    }
  })
  return items
}

function sourceOutlineItems() {
  const lines = getSourceText().split('\n')
  const items = []
  let offset = 0
  let inFence = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence
    } else if (!inFence) {
      const m = /^\s{0,3}(#{1,6})\s+(.+)$/.exec(line)
      if (m) items.push({ level: m[1].length, text: m[2].trim(), pos: offset })
    }
    offset += line.length + 1
  }
  return items
}

function jumpToHeading(item) {
  if (mode === 'source') {
    const pos = Math.min(item.pos, cmView.state.doc.length)
    cmView.focus()
    cmView.dispatch({ selection: { anchor: pos } })
    scrollSourceOffsetTo(pos)
    return
  }
  // 所见即所得：滚动到标题 DOM
  try {
    const res = editor.view.domAtPos(item.pos + 1)
    const el = res.node.nodeType === 1 ? res.node : res.node.parentElement
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  } catch {
    /* pos 已失效，忽略 */
  }
}

// ---------- 文件操作 ----------
// 把本窗口启动参数带入的文件内容载入（每个进程只负责自己的那个文件）
function applyOpenedFile(data) {
  hideWelcome()
  clearTimeout(autoSaveTimer)
  // Go 结构体 JSON 字段为小写（json tag）
  currentPath = data.path || ''
  dirty = false
  docOpen = true
  loadContent(data.content ?? '')
  refreshHeader()
}

// 新建空白文档
function newDocument() {
  hideWelcome()
  clearTimeout(autoSaveTimer)
  currentPath = ''
  dirty = false
  docOpen = true
  loadContent('')
  refreshHeader()
  editor.commands.focus()
}

// ---------- 启动页（新建 / 打开 / 最近打开） ----------
const welcomeScreen = $('welcome-screen')
const recentListEl = $('wc-recent')
const recentItemsEl = $('wc-recent-items')

function showWelcome() {
  welcomeScreen.classList.remove('hidden')
  // 启动页：隐藏编辑类菜单与文档相关按钮，标题栏只留「文件」+ 主题/设置 + 窗口按钮
  document.body.classList.add('welcome-mode')
  wails()?.SetWindowMode(false) // 启动页：小窗口
  refreshRecentFiles()
}

function hideWelcome() {
  welcomeScreen.classList.add('hidden')
  document.body.classList.remove('welcome-mode')
  wails()?.SetWindowMode(true) // 进入编辑：恢复常规大窗口
}

// ---------- 最近打开记录 ----------
// 后端返回 {path, openedAt, openCount, daily:[{date,count}]}。
// openCount 由「最近 7 个有打开记录的日子」里的 daily 加总而来；
// 兼容旧版本 / bindings 里的纯字符串与大驼峰字段
function normalizeRecent(item) {
  if (typeof item === 'string') return { path: item, openedAt: 0, openCount: 1, daily: [] }
  const raw = item?.daily ?? item?.Daily
  const daily = (Array.isArray(raw) ? raw : [])
    .map((d) => ({
      date: String(d?.date ?? d?.Date ?? ''),
      count: Number(d?.count ?? d?.Count ?? 0) || 0,
    }))
    .filter((d) => d.date && d.count > 0)
  const sum = daily.reduce((n, d) => n + d.count, 0)
  return {
    path: item?.path || item?.Path || '',
    openedAt: Number(item?.openedAt ?? item?.OpenedAt ?? 0) || 0,
    openCount: Number(item?.openCount ?? item?.OpenCount ?? 0) || sum || 1,
    daily,
  }
}

function samePath(a, b) {
  if (!a || !b) return false
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()
}

// 打开时间显示成「今天 14:32 / 昨天 09:10 / 11月3日 / 2025/12/1」
function formatRecentTime(ts) {
  if (!ts || ts <= 0) return '时间未知'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '时间未知'
  const now = new Date()
  const yest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  const sameDay = (x, y) =>
    x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (sameDay(d, now)) return `今天 ${hhmm}`
  if (sameDay(d, yest)) return `昨天 ${hhmm}`
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

async function getRecentList() {
  const app = wails()
  if (!app) return []
  try {
    return ((await app.GetRecentFiles()) || []).map(normalizeRecent).filter((x) => x.path)
  } catch {
    return []
  }
}

// 启动页只列出前 8 条，完整 30 条在「快捷打开」里
async function refreshRecentFiles() {
  const list = await getRecentList()
  recentItemsEl.innerHTML = ''
  if (!list.length) {
    recentListEl.classList.add('hidden')
    return
  }
  $('wc-recent-title').textContent = `最近打开（Ctrl+P 查看全部 ${list.length} 条）`
  for (const item of list.slice(0, 8)) {
    const p = item.path
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'recent-item'
    btn.title = p
    const name = document.createElement('span')
    name.className = 'recent-name'
    name.textContent = displayName(p)
    const dir = document.createElement('span')
    dir.className = 'recent-dir'
    dir.textContent = dirName(p)
    const time = document.createElement('span')
    time.className = 'recent-time'
    time.textContent = formatRecentTime(item.openedAt)
    btn.append(name, dir, time)
    btn.addEventListener('click', () => openRecentFile(p))
    recentItemsEl.appendChild(btn)
  }
  recentListEl.classList.remove('hidden')
}

async function openRecentFile(path) {
  try {
    await openMarkdownEntry({ path })
  } catch (e) {
    alert('打开失败：' + (e?.message || e))
    // 文件可能已被移动/删除，刷新列表
    refreshRecentFiles()
  }
}

// ---------- 快捷打开（Ctrl+P）----------
const quickOpenOverlay = $('quick-open-overlay')
const quickOpenInput = $('quick-open-input')
const quickOpenList = $('quick-open-list')
const quickOpenCount = $('quick-open-count')
const quickOpenClear = $('quick-open-clear')
const quickOpenTabs = [...document.querySelectorAll('.quick-open-tab')]
let quickOpenAll = []      // 全部记录
let quickOpenItems = []    // 当前 tab + 搜索后的结果
let quickOpenIndex = 0     // 键盘高亮项
let quickOpenTab = 'time'  // 'time' 时间由近及远 | 'count' 按打开次数
let quickOpenLoading = false
let clearArmed = false
let clearTimer = 0

const isQuickOpenVisible = () => !quickOpenOverlay.classList.contains('hidden')

// 每次打开弹窗都回到默认 tab：时间由近及远
function setQuickOpenTab(tab) {
  quickOpenTab = tab
  quickOpenTabs.forEach((btn) => {
    const active = btn.dataset.tab === tab
    btn.classList.toggle('active', active)
    btn.setAttribute('aria-selected', active ? 'true' : 'false')
  })
  if (isQuickOpenVisible()) renderQuickOpen()
  quickOpenInput.focus()
}

// 两个 tab 各自排序；次数相同时再按最近打开时间排，时间相同时保持后端顺序
function sortQuickOpen(list) {
  return list.slice().sort((a, b) => {
    if (quickOpenTab === 'count') {
      return (b.openCount - a.openCount) || (b.openedAt - a.openedAt)
    }
    return b.openedAt - a.openedAt
  })
}

function resetClearButton() {
  clearTimeout(clearTimer)
  clearArmed = false
  quickOpenClear.textContent = '清空记录'
}

async function openQuickOpen() {
  if (isQuickOpenVisible()) return
  closeMenus()
  resetClearButton()
  setQuickOpenTab('time')
  quickOpenInput.value = ''
  quickOpenAll = []
  quickOpenLoading = true
  // 先显示弹窗，让全局快捷键立刻把后续按键挡在模态之外
  quickOpenOverlay.classList.remove('hidden')
  renderQuickOpen()
  quickOpenInput.focus()
  quickOpenAll = await getRecentList()
  quickOpenLoading = false
  if (isQuickOpenVisible()) renderQuickOpen()
}

function closeQuickOpen() {
  quickOpenOverlay.classList.add('hidden')
  quickOpenInput.blur()
  resetClearButton()
}

function renderQuickOpen() {
  const q = quickOpenInput.value.trim().toLowerCase()
  const sorted = sortQuickOpen(quickOpenAll)
  quickOpenItems = q
    ? sorted.filter((it) => it.path.toLowerCase().includes(q))
    : sorted
  quickOpenIndex = 0
  quickOpenList.innerHTML = ''
  const order = quickOpenTab === 'count' ? '按次数' : '按时间'
  quickOpenCount.textContent = quickOpenAll.length
    ? `${order} · 近 7 个记录日 · ${q ? `${quickOpenItems.length} / ${quickOpenAll.length}` : `${quickOpenAll.length} / 30`} 条`
    : ''
  quickOpenCount.title = '只保留最近 7 个有打开记录的自然日；「打开最多」的次数由这些天的记录加总得出'
  if (!quickOpenItems.length) {
    const empty = document.createElement('div')
    empty.className = 'quick-open-empty'
    empty.textContent = quickOpenLoading
      ? '正在读取最近记录…'
      : q
        ? '没有匹配的文件'
        : '暂无最近打开的文件，先用「打开 Markdown…」打开一个吧'
    quickOpenList.appendChild(empty)
    return
  }
  quickOpenItems.forEach((it, i) => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'quick-open-item' + (i === 0 ? ' active' : '')
    btn.title = it.path
    const name = document.createElement('span')
    name.className = 'quick-open-name'
    name.textContent = baseName(it.path)
    if (samePath(it.path, currentPath)) {
      const badge = document.createElement('span')
      badge.className = 'quick-open-badge'
      badge.textContent = '当前'
      name.appendChild(badge)
    }
    const time = document.createElement('span')
    time.className = 'quick-open-time'
    time.textContent = formatRecentTime(it.openedAt)
    const dir = document.createElement('span')
    dir.className = 'quick-open-dir'
    dir.textContent = dirName(it.path)
    const count = document.createElement('span')
    count.className = 'quick-open-times'
    count.textContent = `${it.openCount || 1} 次`
    // 悬停次数可看到分天明细：次数只统计最近 7 个有记录的日子
    if (it.daily?.length) {
      count.title = '近 7 个记录日：' + it.daily
        .slice()
        .sort((a, b) => b.date.localeCompare(a.date))
        .map((d) => `${d.date.slice(5).replace('-', '/')} ${d.count} 次`)
        .join(' · ')
    }
    btn.append(name, time, dir, count)
    btn.addEventListener('click', () => chooseQuickOpen(i))
    btn.addEventListener('mouseenter', () => setQuickOpenIndex(i))
    quickOpenList.appendChild(btn)
  })
}

function setQuickOpenIndex(i) {
  const items = quickOpenList.querySelectorAll('.quick-open-item')
  if (!items.length) return
  quickOpenIndex = Math.max(0, Math.min(i, items.length - 1))
  items.forEach((el, n) => el.classList.toggle('active', n === quickOpenIndex))
  items[quickOpenIndex].scrollIntoView({ block: 'nearest' })
}

async function chooseQuickOpen(i) {
  const it = quickOpenItems[i]
  if (!it) return
  closeQuickOpen()
  // 选中的就是当前文档：只关掉弹窗，不重复新开窗口
  if (samePath(it.path, currentPath)) return
  await openRecentFile(it.path)
}

quickOpenTabs.forEach((btn) => {
  btn.addEventListener('click', () => setQuickOpenTab(btn.dataset.tab))
})
quickOpenInput.addEventListener('input', renderQuickOpen)
quickOpenInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    if (!quickOpenItems.length) return
    const delta = e.key === 'ArrowDown' ? 1 : -1
    setQuickOpenIndex((quickOpenIndex + delta + quickOpenItems.length) % quickOpenItems.length)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    chooseQuickOpen(quickOpenIndex)
  }
})
quickOpenOverlay.addEventListener('click', (e) => {
  if (e.target === quickOpenOverlay) closeQuickOpen()
})
// 捕获阶段处理 Esc，保证焦点不在输入框时也能关闭
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isQuickOpenVisible()) closeQuickOpen()
}, true)
quickOpenClear.addEventListener('click', async () => {
  if (!clearArmed) {
    clearArmed = true
    quickOpenClear.textContent = '确认清空？'
    clearTimer = setTimeout(resetClearButton, 3000)
    return
  }
  resetClearButton()
  try {
    await wails()?.ClearRecentFiles?.()
  } catch {
    /* 浏览器开发模式下没有 Wails runtime */
  }
  quickOpenAll = []
  renderQuickOpen()
  refreshRecentFiles()
})

$('wc-new').addEventListener('click', newDocument)
$('wc-open').addEventListener('click', openFile)
// 启动页右上角：复用顶部工具栏的主题/设置逻辑
$('wc-theme').addEventListener('click', toggleTheme)
$('wc-settings').addEventListener('click', () => openSettings())

// wails 文件拖放：.md 打开文档，图片导入编辑器
// 注意：wails 事件参数为 (x, y, paths)
const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif']

let wailsDropHandled = false // wails 路径链路是否已处理本次拖入

// 打开 .md 的统一入口：
// - 启动页（还没有文档）→ 直接用当前窗口，不新起进程
// - 已打开文档 → 一律新窗口，不覆盖当前内容
async function openMarkdownEntry(entry) {
  const app = wails()
  if (!app) return
  if (!docOpen) {
    const data = entry.path ? await app.OpenPath(entry.path) : entry
    applyOpenedFile(data)
    return
  }
  if (entry.path) {
    await app.OpenInNewWindow(entry.path)
  } else {
    // 拿不到磁盘路径时（浏览器拖放兜底），把内容写入临时文件后交给新窗口
    await app.OpenContentInNewWindow(entry.content ?? '', entry.fileName || '未命名.md')
  }
}

async function handleDroppedMarkdown(entry) {
  await openMarkdownEntry(entry)
}

window.runtime?.EventsOn?.('wails:file-drop', async (x, y, paths) => {
  if (!paths || !paths.length) return
  wailsDropHandled = true
  const app = wails()
  if (!app) return

  // 优先处理拖入的 markdown 文件（一律新窗口）
  for (const p of paths) {
    const ext = (p.split('.').pop() || '').toLowerCase()
    if (ext === 'md' || ext === 'markdown') {
      try {
        await handleDroppedMarkdown({ path: p })
      } catch (e) {
        console.error(e)
        alert('打开失败: ' + e)
      }
      return
    }
  }

  // 拖入的是图片 → 导入资源目录并插入文档
  for (const p of paths) {
    const ext = (p.split('.').pop() || '').toLowerCase()
    if (imageExts.includes(ext)) {
      try {
        const res = await app.ImportImage(p)
        if (res?.src) {
          editor.chain().focus().setImage({ src: res.src }).run()
        }
      } catch (e) {
        console.error(e)
        alert('导入图片失败: ' + e)
      }
    }
  }
})

// ---------- 拖放保险层 ----------
// wails 的拖放拦截依赖运行时注入，可能未激活；这里自行阻止 WebView
// 默认行为（把 .md 当文本打开 / 弹浏览器）。wails 路径链路未生效时
// 只能拿到文件内容（无路径），交给 Go 写入临时文件后同样在新窗口打开。
const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files')

window.addEventListener(
  'dragover',
  (e) => {
    if (hasFiles(e)) e.preventDefault()
  },
  { capture: true },
)

window.addEventListener(
  'drop',
  (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()

    const files = [...(e.dataTransfer.items || [])]
      .filter((i) => i.kind === 'file')
      .map((i) => i.getAsFile())
      .filter(Boolean)
    if (!files.length) return

    // 直接通过 WebView2 原生桥请求 Go 解析真实路径。
    // 不依赖 wails 运行时的拖放模块是否激活（消息格式与 wails 一致：file:drop:<x>:<y>）
    if (window.chrome?.webview?.postMessageWithAdditionalObjects) {
      window.chrome.webview.postMessageWithAdditionalObjects(
        `file:drop:${Math.round(e.x)}:${Math.round(e.y)}`,
        files,
      )
    }

    // 兜底：400ms 内 wails 路径链路没回来，按内容处理（无路径）
    wailsDropHandled = false
    setTimeout(async () => {
      if (wailsDropHandled) return
      for (const f of files) {
        const ext = (f.name.split('.').pop() || '').toLowerCase()
        if (ext === 'md' || ext === 'markdown') {
          try {
            const text = await f.text()
            await handleDroppedMarkdown({ path: '', content: text, fileName: f.name })
          } catch (err) {
            console.error(err)
            alert('读取拖入文件失败: ' + err)
          }
          return
        }
      }
    }, 400)
  },
  { capture: true },
)

// 打开 .md（Ctrl+O / Ctrl+Shift+O）：启动页复用当前窗口，已有文档时新开窗口
async function openFile() {
  const app = wails()
  if (!app) return
  try {
    const path = await app.PickMarkdownPath()
    if (!path) return
    await openMarkdownEntry({ path })
  } catch (e) {
    console.error(e)
    alert('打开失败: ' + e)
  }
}

function loadContent(md) {
  lastMarkdown = md
  rawMarkdown = md
  wysiwygEdited = false
  sourceDirty = false
  setMarkdown(editor, md)
  setSourceText(md)
  // 记录每个块在文件文本里的行，供模式切换时定位
  blockLineMap = buildBlockLineMap(md, editor.state.doc)
  refreshStats(md)
  refreshOutline()
}

function currentMarkdown() {
  return mode === 'source' ? getSourceText() : getMarkdown(editor)
}

async function saveDocument() {
  const app = wails()
  if (!app) return
  try {
    const md = currentMarkdown()
    const saved = currentPath
      ? await app.SaveMarkdown(md)
      : await app.SaveMarkdownAs(md)
    if (!saved) return // 另存为被取消
    const dirChanged = dirName(currentPath) !== dirName(saved)
    currentPath = saved
    rawMarkdown = md
    if (mode === 'wysiwyg' && lastMarkdown === md) wysiwygEdited = false
    dirty = false
    refreshHeader()
    if (dirChanged) loadContent(md)
  } catch (e) {
    console.error(e)
    alert('保存失败: ' + e)
  }
}

async function saveFileAs() {
  const app = wails()
  if (!app) return
  try {
    const md = currentMarkdown()
    const saved = await app.SaveMarkdownAs(md)
    if (!saved) return
    const dirChanged = dirName(currentPath) !== dirName(saved)
    currentPath = saved
    rawMarkdown = md
    if (mode === 'wysiwyg' && lastMarkdown === md) wysiwygEdited = false
    dirty = false
    refreshHeader()
    if (dirChanged) loadContent(md)
  } catch (e) {
    console.error(e)
    alert('另存为失败: ' + e)
  }
}

$('btn-open').addEventListener('click', openFile)
$('btn-save').addEventListener('click', saveDocument)
$('btn-save-as').addEventListener('click', saveFileAs)

// 状态栏「打开所在目录」：在资源管理器中定位当前文件
$('status-reveal').addEventListener('click', () => {
  if (!currentPath) return
  wails()?.RevealInExplorer(currentPath)
})

// ---------- 设置面板 ----------
const overlay = $('settings-overlay')
const selMode = $('set-asset-mode')
const inpFolder = $('set-assets-folder')
const inpCustomDir = $('set-custom-dir')
const rowFolder = $('row-assets-folder')
const rowCustomDir = $('row-custom-dir')

function refreshSettingsRows() {
  const custom = selMode.value === 'custom'
  rowFolder.classList.toggle('hidden', custom)
  rowCustomDir.classList.toggle('hidden', !custom)
}

// ---------- 主题 ----------
function applyTheme(theme) {
  document.body.classList.toggle('dark', theme !== 'light')
}

// 主题切换：菜单项与（已从标题栏收起的）按钮共用同一个函数
async function toggleTheme() {
  const app = wails()
  const next = document.body.classList.contains('dark') ? 'light' : 'dark'
  applyTheme(next)
  if (!app) return
  try {
    const s = await app.GetSettings()
    await app.SaveSettings({
      AssetMode: s.assetMode,
      AssetsFolder: s.assetsFolder,
      CustomDir: s.customDir,
      Theme: next,
    })
  } catch (e) {
    console.error(e)
  }
}
$('btn-theme').addEventListener('click', toggleTheme)

async function openSettings() {
  const app = wails()
  if (!app) return
  try {
    const s = await app.GetSettings()
    selMode.value = s.assetMode
    inpFolder.value = s.assetsFolder
    inpCustomDir.value = s.customDir || ''
    $('set-theme').value = s.theme || 'dark'
    refreshSettingsRows()
    overlay.classList.remove('hidden')
  } catch (e) {
    alert('读取设置失败: ' + e)
  }
}

async function saveSettings() {
  const app = wails()
  if (!app) return
  try {
    const theme = $('set-theme').value
    await app.SaveSettings({
      AssetMode: selMode.value,
      AssetsFolder: inpFolder.value.trim() || 'assets',
      CustomDir: inpCustomDir.value,
      Theme: theme,
    })
    applyTheme(theme) // 立即生效
    overlay.classList.add('hidden')
  } catch (e) {
    alert('保存设置失败: ' + e)
  }
}

$('btn-settings').addEventListener('click', openSettings)
$('btn-settings-ok').addEventListener('click', saveSettings)
$('btn-settings-cancel').addEventListener('click', () => overlay.classList.add('hidden'))
overlay.addEventListener('click', (e) => {
  if (e.target === overlay) overlay.classList.add('hidden')
})
selMode.addEventListener('change', refreshSettingsRows)
$('btn-choose-dir').addEventListener('click', async () => {
  const app = wails()
  if (!app) return
  const dir = await app.ChooseDirectory()
  if (dir) inpCustomDir.value = dir
})

// ---------- 关于 ----------
// 版本号由后端从 wails.json 读取，发版时只需改一处配置
const aboutOverlay = $('about-overlay')
const ABOUT_REPO_URL = 'https://github.com/ggbao666/lite-mark-view'

async function openAbout() {
  let info = null
  const app = wails()
  if (app) {
    try {
      info = await app.GetAppInfo()
    } catch (e) {
      console.error(e)
    }
  }
  $('about-name').textContent = info?.name || info?.Name || 'LiteMark View'
  $('about-version').textContent = `v${info?.version || info?.Version || 'dev'}`
  $('about-tech').textContent = info?.tech || info?.Tech || 'Go + Wails + Tiptap / CodeMirror'
  const url = info?.repository || info?.Repository || ABOUT_REPO_URL
  const link = $('about-repo')
  link.textContent = url
  link.href = url
  link.dataset.url = url
  aboutOverlay.classList.remove('hidden')
  $('btn-about-close').focus()
}

function closeAbout() {
  aboutOverlay.classList.add('hidden')
}

async function openAboutLink(e) {
  e?.preventDefault()
  const url = $('about-repo').dataset.url || ABOUT_REPO_URL
  const app = wails()
  if (app) {
    try {
      await app.OpenExternalLink(url) // 后端白名单校验后交给系统默认浏览器
      return
    } catch (err) {
      console.error(err)
    }
  }
  window.open(url, '_blank', 'noopener')
}

$('about-repo').addEventListener('click', openAboutLink)
$('about-repo-btn').addEventListener('click', openAboutLink)
$('btn-about-close').addEventListener('click', closeAbout)
aboutOverlay.addEventListener('click', (e) => {
  if (e.target === aboutOverlay) closeAbout()
})
// 捕获阶段处理 Esc，焦点在按钮/链接上时也能关闭
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !aboutOverlay.classList.contains('hidden')) closeAbout()
}, true)

// ---------- 全局快捷键 ----------
// 有模态框打开时不响应，保证模态期间不能操作背后的编辑器
const hasOpenModal = () => !!document.querySelector('.modal-overlay:not(.hidden)')

window.addEventListener('keydown', (e) => {
  if (hasOpenModal()) return
  const mod = e.ctrlKey || e.metaKey
  if (!mod) return
  const k = e.key.toLowerCase()
  if (k === 's') {
    e.preventDefault()
    saveDocument()
  } else if (k === 'o') {
    e.preventDefault()
    openFile() // 含 Shift：一律新窗口
  } else if (k === 'p') {
    e.preventDefault()
    openQuickOpen()
  } else if (k === 'f') {
    e.preventDefault()
    openFind(false)
  } else if (k === 'h') {
    e.preventDefault()
    openFind(true)
  } else if (k === '/' || k === '?') {
    e.preventDefault()
    if (e.shiftKey) {
      // Ctrl+Shift+/：原 CodeMirror 的注释键位挪到这里，只在源码模式下生效
      // （不同键盘布局下 Ctrl+Shift+/ 的 e.key 可能是 '/' 或 '?'，都兼容）
      if (mode === 'source') toggleComment(cmView)
    } else {
      toggleEditorMode()
    }
  }
})

// ---------- 关闭流程：未保存 → 询问「保留 / 废弃」；再按设置退出或留在后台 ----------
const unsavedOverlay = $('unsaved-overlay')
let closingWithTray = true

function showUnsavedDialog() {
  $('unsaved-name').textContent = currentPath
    ? displayName(currentPath)
    : '未命名文档（保存时需要选择位置）'
  unsavedOverlay.classList.remove('hidden')
}

// 已命名的文件本来就有自动保存，关闭时补存一次，避免 2s 防抖误报未保存
async function flushAutoSave() {
  if (!dirty) return true
  if (!currentPath) return false
  const app = wails()
  if (!app) return false
  try {
    await app.SaveMarkdown(currentMarkdown())
    dirty = false
    refreshHeader()
    return true
  } catch (e) {
    console.error('关闭前保存失败', e)
    return false
  }
}

async function onCloseRequested(hasTray) {
  closingWithTray = !!hasTray
  if (!(await flushAutoSave())) {
    showUnsavedDialog()
    return
  }
  await finishClose()
}

// 未保存内容处理完（或本来就没有）后，按设置决定退出方式
async function finishClose() {
  const app = wails()
  if (!app) return
  if (!closingWithTray) {
    app.ConfirmClose('exit', false) // 附属窗口没有托盘，直接退出
    return
  }
  let action = 'ask'
  try {
    action = (await app.GetSettings()).closeAction || 'ask'
  } catch {
    /* 读取失败按询问处理 */
  }
  if (action === 'exit') app.ConfirmClose('exit', false)
  else if (action === 'background') app.ConfirmClose('background', false)
  else showExitDialog()
}

$('btn-unsaved-cancel').addEventListener('click', () => unsavedOverlay.classList.add('hidden'))
$('btn-unsaved-discard').addEventListener('click', async () => {
  unsavedOverlay.classList.add('hidden')
  dirty = false
  refreshHeader()
  await finishClose()
})
$('btn-unsaved-save').addEventListener('click', async () => {
  const app = wails()
  if (!app) return
  try {
    const saved = currentPath
      ? await app.SaveMarkdown(currentMarkdown())
      : await app.SaveMarkdownAs(currentMarkdown())
    if (!saved) return // 取消选择保存位置 → 留在编辑器
    currentPath = saved
    dirty = false
    refreshHeader()
  } catch (e) {
    alert('保存失败: ' + e)
    return
  }
  unsavedOverlay.classList.add('hidden')
  await finishClose()
})

// ---------- 关闭询问（退出 / 留在后台托盘） ----------
const exitOverlay = $('exit-overlay')

function showExitDialog() {
  $('exit-remember').checked = false
  exitOverlay.classList.remove('hidden')
}

$('btn-exit-cancel').addEventListener('click', () => exitOverlay.classList.add('hidden'))
$('btn-exit-quit').addEventListener('click', () => {
  exitOverlay.classList.add('hidden')
  wails()?.ConfirmClose('exit', $('exit-remember').checked)
})
$('btn-exit-background').addEventListener('click', () => {
  exitOverlay.classList.add('hidden')
  wails()?.ConfirmClose('background', $('exit-remember').checked)
})

// Go 侧关闭拦截 → 先处理未保存内容，再询问退出方式
window.runtime?.EventsOn?.('close-requested', (hasTray) => onCloseRequested(hasTray))

// 关闭到后台后再打开：回到启动页（不再显示上次关闭的文档）
function resetToWelcome() {
  clearTimeout(autoSaveTimer)
  // 内容已自动保存（已命名的文件写盘），这里只清空界面与当前路径
  currentPath = ''
  dirty = false
  docOpen = false
  setMode('wysiwyg')
  loadContent('')
  refreshHeader()
  wails()?.ClosePath()
  showWelcome()
}

// 窗口被唤出（托盘/再次双击 exe）：
// 关闭到后台的重开 → 启动页；尚未进入编辑状态 → 补显启动页
window.runtime?.EventsOn?.('window-shown', (reset) => {
  if (reset && docOpen) resetToWelcome()
  else if (!docOpen) showWelcome()
})

// ---------- 设置面板加：注册 .md 文件关联 ----------
$('btn-register-md').addEventListener('click', async () => {
  const app = wails()
  if (!app) return
  try {
    const msg = await app.RegisterMdAssociation()
    alert(msg)
  } catch (e) {
    alert('注册失败: ' + e)
  }
})

// ---------- 菜单栏（文件 / 编辑 / 插入 / 视图）与自绘窗口按钮 ----------
const menuBar = $('menu-bar')
const allMenus = [...menuBar.querySelectorAll('.menu')]

// 源码模式按钮已收进菜单：菜单项文字随当前模式变化，避免「切回」时文案误导
const menuModeText = $('menu-mode-text')
function syncModeMenuText() {
  if (!menuModeText) return
  menuModeText.textContent = document.body.classList.contains('source-mode')
    ? '切换到所见即所得'
    : '切换到源码模式'
}
new MutationObserver(syncModeMenuText).observe(document.body, {
  attributes: true,
  attributeFilter: ['class'],
})
syncModeMenuText()

function closeMenus() {
  allMenus.forEach((m) => {
    m.classList.remove('open')
    m.querySelector('.menu-pop').classList.add('hidden')
  })
}

function openMenu(menu) {
  if (!menu) return
  closeMenus()
  const pop = menu.querySelector('.menu-pop')
  const rect = menu.querySelector('.menu-label').getBoundingClientRect()
  // fixed 定位，靠左对齐菜单标题；贴近右边缘时向内收，避免越出窗口
  pop.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - 232))}px`
  pop.style.top = `${rect.bottom + 2}px`
  pop.classList.remove('hidden')
  menu.classList.add('open')
}

allMenus.forEach((menu) => {
  const label = menu.querySelector('.menu-label')
  label.addEventListener('click', (e) => {
    e.stopPropagation()
    if (menu.classList.contains('open')) closeMenus()
    else openMenu(menu)
  })
  // 菜单已展开时，鼠标移到其他标题上直接切换
  label.addEventListener('mouseenter', () => {
    if (menuBar.querySelector('.menu.open') && !menu.classList.contains('open')) openMenu(menu)
  })
})

// 「编辑(E) → 选择全文」：一次把选区扩展到整篇文档。
// 代码块内的 Ctrl+A 是递进式的（先选代码块、再按一次才选全文），这里不依赖按键次数；
// 源码模式直接把 CodeMirror 的主选区设为全文，不滚动视口。
function selectAllDocument() {
  if (!docOpen) return
  if (mode === 'source') {
    cmView.focus()
    cmView.dispatch({ selection: { anchor: 0, head: cmView.state.doc.length } })
  } else {
    editor.chain().focus().selectAll().run()
  }
}

const menuCommands = {
  about: () => openAbout(),
  'select-all': () => selectAllDocument(),
  'quick-open': () => openQuickOpen(),
  'win-quit': () => window.runtime?.Quit?.(),
  'find-replace': () => openFind(true),
  undo: () => editor.chain().focus().undo().run(),
  redo: () => editor.chain().focus().redo().run(),
  // 这些按钮已从标题栏收进菜单，直接调用功能函数，不依赖隐藏按钮的 click 派发
  'btn-mode': () => toggleEditorMode(),
  'btn-outline': () => toggleOutline(),
  'btn-theme': () => toggleTheme(),
  'btn-settings': () => openSettings(),
}

menuBar.querySelectorAll('.menu-item').forEach((item) => {
  item.addEventListener('click', () => {
    const action = item.dataset.action
    closeMenus()
    // 其余项复用原工具栏按钮上的事件（按钮 DOM 仍保留，只是不在界面显示）
    if (menuCommands[action]) menuCommands[action]()
    else $(action)?.click()
  })
})

document.addEventListener('click', (e) => {
  if (!e.target.closest('.menu-bar')) closeMenus()
})

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeMenus()
    return
  }
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    const map = { f: 'file', e: 'edit', i: 'insert', v: 'view', t: 'tools' }
    const name = map[e.key.toLowerCase()]
    if (name) {
      e.preventDefault()
      openMenu(menuBar.querySelector(`.menu[data-menu="${name}"]`))
    }
  }
})

// 双击标题栏空白处切换最大化（按钮上不触发）
$('titlebar').addEventListener('dblclick', (e) => {
  if (e.target.closest('button, input, .menu-pop')) return
  window.runtime?.WindowToggleMaximise?.()
})

const winMaxBtn = $('btn-win-max')
async function syncMaximizeButton() {
  try {
    const maxed = await window.runtime?.WindowIsMaximised?.()
    winMaxBtn.classList.toggle('is-max', !!maxed)
  } catch {
    /* 浏览器开发模式下没有 Wails runtime */
  }
}

$('btn-win-min').addEventListener('click', () => window.runtime?.WindowMinimise?.())
winMaxBtn.addEventListener('click', () => {
  window.runtime?.WindowToggleMaximise?.()
  setTimeout(syncMaximizeButton, 120)
})
// 关闭走 runtime.Quit → 触发 Go 的 OnBeforeClose，复用「未保存 / 退出方式」询问流程
$('btn-win-close').addEventListener('click', () => window.runtime?.Quit?.())
window.addEventListener('resize', syncMaximizeButton)
syncMaximizeButton()

// ---------- 初始化 ----------
async function init() {
  const app = wails()
  // 先应用主题，避免暗色用户看到闪白
  applyTheme('dark')
  try {
    if (app) {
      const s = await app.GetSettings()
      applyTheme(s.theme)
    }
  } catch (e) {
    console.error(e)
  }
  refreshHeader()
  refreshStats(getMarkdown(editor))
  refreshOutline()
  if (!app) return
  // 命令行带入的文件（双击 .md / 右键打开方式）
  let opened = false
  try {
    const startupFile = await app.GetStartupFile()
    if (startupFile) {
      applyOpenedFile(startupFile)
      opened = true
    }
  } catch (e) {
    console.error(e)
  }
  if (!opened) showWelcome()
  else editor.commands.focus()
}
init()
