
// The "Copy code" link the markdown renderer puts under a code block (src/main/markdown.ts).
// The link has no handler of its own, since the content security policy of the app forbids inline
// handlers: one listener on the document serves every link, wherever the message is displayed.

const kCopyLabel = 'Copy code'
const kCopiedLabel = 'Copied!'
const kCopiedDelay = 1000

const onClick = (event: Event): void => {

  const target = event.target as Element | null
  const link = target?.closest?.('a.copy-code[data-copy-code]') as HTMLElement | null
  if (!link) return

  // the link has no href: nothing to navigate to, but nothing else should react to the click either
  event.preventDefault()

  try {
    const code = window.api.base64.decode(link.getAttribute('data-copy-code'))
    Promise.resolve(navigator.clipboard.writeText(code)).catch((error) => {
      console.error('Could not copy the code', error)
    })
  } catch (error) {
    console.error('Could not copy the code', error)
    return
  }

  link.textContent = kCopiedLabel
  setTimeout(() => {
    link.textContent = kCopyLabel
  }, kCopiedDelay)

}

/**
 * To be called once per document.
 * @returns a function that removes the listener
 */
export const installCopyCodeHandler = (doc: Document = document): () => void => {
  doc.addEventListener('click', onClick)
  return () => doc.removeEventListener('click', onClick)
}
