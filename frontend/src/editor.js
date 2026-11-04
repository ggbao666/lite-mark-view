import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table'
import Highlight from '@tiptap/extension-highlight'
import { BubbleMenu } from '@tiptap/extension-bubble-menu'
import markPlugin from 'markdown-it-mark'
import { Markdown } from 'tiptap-markdown'

// 本地图片显示地址转换：markdown 里的相对/绝对路径 → /local-file 预览地址
function toDisplaySrc(src, getCurrentDir) {
  if (!src) return src
  if (/^(https?:|data:|blob:)/i.test(src)) return src
  // Windows 盘符绝对路径 / UNC
  if (/^[a-zA-Z]:[\\/]/.test(src) || src.startsWith('//')) {
    return '/local-file?path=' + encodeURIComponent(src)
  }
  if (src.startsWith('/')) return src // 应用内资源路径，原样
  // 相对路径 → 相对当前文件所在目录
  const dir = (getCurrentDir?.() || '').replace(/[\\/]+$/, '')
  const abs = dir ? dir + '/' + src : src
  return '/local-file?path=' + encodeURIComponent(abs)
}

// 从剪贴板/拖拽携带的 HTML 中提取网络图片地址（转存用）
function extractRemoteImageUrls(html) {
  if (!html) return []
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const urls = []
  for (const img of doc.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src') || ''
    if (/^https?:\/\//i.test(src)) urls.push(src)
  }
  return [...new Set(urls)]
}

// 高亮扩展定制：
// - 导出 markdown 时用 ==文字== 语法（Typora 同款）
// - 解析时同时认识 ==文字==（markdown-it-mark 插件）和 <mark>文字</mark>（html: true 透传）
const seenMdInstances = new WeakSet()
const HighlightMd = Highlight.extend({
  addStorage() {
    return {
      markdown: {
        serialize: {
          open: '==',
          close: '==',
          mixable: true,
          expelEnclosingWhitespace: true,
        },
        parse: {
          setup(markdownit) {
            // parse() 每次调用都会重跑 setup，防止插件重复注册
            if (seenMdInstances.has(markdownit)) return
            seenMdInstances.add(markdownit)
            markdownit.use(markPlugin)
          },
        },
      },
    }
  },
})

export function createEditor(element, { onUpdate, getCurrentDir, uploadImage, downloadImage, bubbleElement }) {
  async function insertImageFiles(files) {
    for (const file of files) {
      try {
        const res = await uploadImage?.(file)
        if (res?.src) {
          editor.chain().focus().setImage({ src: res.src, alt: file.name }).run()
        }
      } catch (e) {
        console.error(e)
        alert('图片保存失败: ' + e)
      }
    }
  }

  // 网络图片 → Go 端下载落盘 → 插入本地引用
  async function downloadAndInsert(urls) {
    for (const url of urls) {
      try {
        const res = await downloadImage?.(url)
        if (res?.src) {
          editor.chain().focus().setImage({ src: res.src }).run()
        }
      } catch (e) {
        console.error(e)
        alert('下载图片失败: ' + e)
      }
    }
  }

  function handleImageTransfer(dataTransfer, moved) {
    if (moved) return false
    // 1) 剪贴板/拖拽自带图片文件（截图、右键复制图片）
    const files = Array.from(dataTransfer?.files || []).filter((f) =>
      f.type.startsWith('image/'),
    )
    if (files.length) {
      insertImageFiles(files)
      return true
    }
    // 2) 网页复制的图文 HTML 中携带的网络图片 → 转存到本地
    const urls = extractRemoteImageUrls(dataTransfer?.getData('text/html') || '')
    if (urls.length) {
      downloadAndInsert(urls)
      return true
    }
    return false
  }

  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4, 5, 6] },
      }),
      Image.configure({ inline: false, allowBase64: true }).extend({
        renderHTML({ node, HTMLAttributes }) {
          // attrs.src 保持 markdown 原文路径（tiptap-markdown 导出用它），
          // 仅在 DOM 渲染时转换为本地文件预览地址
          return ['img', { ...HTMLAttributes, src: toDisplaySrc(HTMLAttributes.src, getCurrentDir) }]
        },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      HighlightMd.configure({ multicolor: true }),
      BubbleMenu.configure({
        element: bubbleElement,
        shouldShow: ({ editor: e, state }) =>
          !state.selection.empty && !e.isActive('image'),
        options: { placement: 'top', offset: 8 },
      }),
      Markdown.configure({
        html: true, // 高亮等 markdown 没有的格式以 <mark> 等 HTML 往返
        linkify: true,
        breaks: false,
        transformPastedText: true,
        transformCopiedText: false,
      }),
    ],
    content: '', // 启动时空白；由启动页引导新建/打开/拖拽
    onUpdate: ({ editor }) => onUpdate(getMarkdown(editor)),
    editorProps: {
      handlePaste: (_view, event) => {
        const handled = handleImageTransfer(event.clipboardData, false)
        if (handled) event.preventDefault()
        return handled
      },
      handleDrop: (_view, event, _slice, moved) => {
        const handled = handleImageTransfer(event.dataTransfer, moved)
        if (handled) event.preventDefault()
        return handled
      },
    },
  })
  return editor
}

export function getMarkdown(editor) {
  return editor.storage.markdown.getMarkdown()
}

// 替换内容但不触发 onUpdate（避免打开文件时误标脏状态）
export function setMarkdown(editor, md) {
  editor.commands.setContent(md, { emitUpdate: false })
}

export function countWords(text) {
  const t = text.replace(/\s+/g, '')
  return t.length
}
