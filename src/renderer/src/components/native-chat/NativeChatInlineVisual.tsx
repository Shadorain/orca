import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { SquareArrowOutUpRight } from 'lucide-react'
import { ArtifactPublishButton } from '@/components/artifacts/ArtifactPublishButton'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { NATIVE_CHAT_VISUAL_RESERVED_HEIGHT, NativeChatVisualFrame } from './NativeChatVisualFrame'
import { observeTranscriptVisibility } from './NativeChatTranscriptChrome'
import {
  useNativeChatVisualReading,
  type NativeChatVisualOwner,
  type NativeChatVisualReading
} from './native-chat-visual-owner'
import {
  useNativeChatVisualDocument,
  type NativeChatVisualSource
} from './use-native-chat-visual-document'
import { nativeChatVisualHostPath } from '../../../../shared/native-chat-visual-host-path'
import {
  markNativeChatVisualReads,
  nativeChatVisualFileKey,
  type NativeChatVisualFile
} from './native-chat-visual-path-read-client'
import { useNativeChatVisualSavedMark } from './native-chat-visual-refresh'
import { openNativeChatVisual } from './native-chat-visual-open'
import {
  nativeChatVisualArtifactSourceKey,
  readNativeChatVisualArtifactRequest
} from './native-chat-visual-share'

const subscribeToNothing = (): (() => void) => () => {}
const noMark = (): number => 0

type NativeChatVisualHostFile =
  | Extract<NativeChatVisualSource, { kind: 'legacy' | 'pending' }>
  | { kind: 'file'; file: NativeChatVisualFile }

/** The visual's file on the chat's own host, or the older endpoint where the host has no folder. */
function useNativeChatVisualHostFile(
  owner: NativeChatVisualOwner,
  reading: NativeChatVisualReading | null,
  file: string
): NativeChatVisualHostFile {
  const route = reading?.route ?? null
  return useMemo(() => {
    const identity = { target: owner.target, sessionId: owner.sessionId, file }
    const path =
      route === null || route.kind === 'legacy'
        ? null
        : nativeChatVisualHostPath(route.scratchDirectory, file)
    if (route === null || path === null) {
      return { kind: 'legacy', identity }
    }
    const hostFile = { target: owner.target, path }
    return route.kind === 'pending'
      ? { kind: 'pending', file: hostFile, identity }
      : { kind: 'file', file: hostFile }
  }, [file, owner.sessionId, owner.target, route])
}

export function NativeChatVisualUnavailable(): React.JSX.Element {
  return (
    <p className="my-2 text-xs text-chat-foreground-faint">
      {translate('components.native-chat.visualUnavailable', 'Visualization unavailable')}
    </p>
  )
}

/**
 * A visual inside an assistant reply. Its frame mounts once the reply scrolls near it and stays
 * mounted, so what the reader did in it survives scrolling away and back.
 */
export function NativeChatInlineVisual({
  owner,
  file,
  title
}: {
  owner: NativeChatVisualOwner
  file: string
  title: string | null
}): React.JSX.Element {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [near, setNear] = useState(false)
  const [revealedMark, setRevealedMark] = useState(0)
  const [sharedMark, setSharedMark] = useState(0)
  const [retired, setRetired] = useState(false)
  const reading = useNativeChatVisualReading()
  const hostFile = useNativeChatVisualHostFile(owner, reading, file)
  const chatRefreshMark = useSyncExternalStore(
    reading?.refresh.subscribe ?? subscribeToNothing,
    reading?.refresh.mark ?? noMark,
    reading?.refresh.mark ?? noMark
  )
  const savedMark = useNativeChatVisualSavedMark(hostFile.kind === 'file' ? hostFile.file : null)
  // Marks only grow, so the largest is the latest trigger.
  const freshAfter = Math.max(chatRefreshMark, savedMark, revealedMark, sharedMark)
  const source = useMemo<NativeChatVisualSource>(
    () => (hostFile.kind === 'file' ? { ...hostFile, freshAfter } : hostFile),
    [freshAfter, hostFile]
  )
  const state = useNativeChatVisualDocument(source, near)
  const boxShown = !retired && state.status !== 'unavailable'

  useEffect(() => {
    const element = boxRef.current
    if (!element || !boxShown) {
      return
    }
    let seen = false
    let hidden = false
    return observeTranscriptVisibility(element, (visible) => {
      if (!visible) {
        hidden = seen
        return
      }
      setNear(true)
      // Brought back into view after being scrolled away or hidden: the file may have changed.
      if (hidden) {
        setRevealedMark(markNativeChatVisualReads())
      }
      seen = true
      hidden = false
    })
  }, [boxShown])

  if (!boxShown) {
    return <NativeChatVisualUnavailable />
  }
  const label = title ?? file
  const shareFile = hostFile.kind === 'file' ? hostFile.file : null

  return (
    <div ref={boxRef} className="group/visual relative my-3">
      {state.status === 'ready' && near ? (
        <>
          <NativeChatVisualFrame
            document={state.document}
            title={label}
            layout="inline"
            themeScope={boxRef}
            onRetired={() => setRetired(true)}
          />
          <NativeChatInlineVisualToolbar
            // Why keyed: Share's open state belongs to one shareable file; losing path reads drops it.
            key={shareFile ? nativeChatVisualFileKey(shareFile) : 'open-only'}
            owner={owner}
            file={file}
            title={title}
            shareFile={shareFile}
            onShareReadStarted={setSharedMark}
          />
        </>
      ) : (
        <div
          role="status"
          aria-label={translate('components.native-chat.visualLoading', 'Loading visualization')}
          className="w-full rounded-md bg-muted/30"
          style={{ height: NATIVE_CHAT_VISUAL_RESERVED_HEIGHT }}
        />
      )}
    </div>
  )
}

/** Owns Share's open state, so a visual that returns, or regains path reads, starts closed. */
function NativeChatInlineVisualToolbar({
  owner,
  file,
  title,
  shareFile,
  onShareReadStarted
}: {
  owner: NativeChatVisualOwner
  file: string
  title: string | null
  /** Null on a host that can't read the file by path, where Share is not offered. */
  shareFile: NativeChatVisualFile | null
  onShareReadStarted: (startedAfter: number) => void
}): React.JSX.Element {
  // Share's popover is portalled and takes focus, so hover and focus-within can't hold the toolbar.
  const [shareOpen, setShareOpen] = useState(false)
  const openLabel = translate('components.native-chat.visualOpenInNewTab', 'Open in new tab')
  return (
    <div
      data-share-open={shareOpen}
      className="absolute top-2 right-2 flex items-center gap-1 transition-opacity can-hover:opacity-0 group-hover/visual:opacity-100 focus-within:opacity-100 data-[share-open=true]:opacity-100"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="icon-xs"
            aria-label={openLabel}
            onClick={() =>
              openNativeChatVisual(owner, { file, title, path: shareFile ? shareFile.path : null })
            }
          >
            <SquareArrowOutUpRight />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {openLabel}
        </TooltipContent>
      </Tooltip>
      {shareFile ? (
        <ArtifactPublishButton
          variant="outline"
          size="icon-xs"
          sourceKey={nativeChatVisualArtifactSourceKey(shareFile)}
          createRequest={() => readNativeChatVisualArtifactRequest(shareFile, onShareReadStarted)}
          open={shareOpen}
          onOpenChange={setShareOpen}
        />
      ) : null}
    </div>
  )
}
