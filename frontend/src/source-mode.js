import { EditorView, basicSetup } from 'codemirror'
import { EditorState, Prec } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { markdown } from '@codemirror/lang-markdown'

// CodeMirror 6 源码模式编辑器
export function createSourceEditor(element, { onChange, onSave }) {
  const view = new EditorView({
    parent: element,
    state: EditorState.create({
      doc: '',
      extensions: [
        basicSetup,
        markdown(),
        Prec.highest(
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                onSave()
                return true
              },
            },
          ]),
        ),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChange(u.state.doc.toString())
        }),
      ],
    }),
  })
  return view
}

export function setSourceDoc(view, md) {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: md },
  })
}

export function getSourceDoc(view) {
  return view.state.doc.toString()
}
