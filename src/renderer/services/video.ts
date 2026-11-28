
import { fal } from '@fal-ai/client'
import { GoogleGenAI, PersonGeneration } from '@google/genai'
import { xAIBaseURL } from 'multi-llm-ts'
import Replicate, { FileOutput } from 'replicate'
import { anyDict, MediaCreationEngine, MediaCreator, MediaReference } from 'types/index'
import { download, saveFileContents } from './download'
import { engineNames } from './llms/base'
import { createIpcMediaSink } from './media_sink'
import { store } from './store'
import { VeniceVideoModelMeta } from './venice'
import { generateVeniceVideo, VeniceVideoError } from './venice_video'

// Type definitions for OpenAI Video API
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type VideoModel = 'sora-2' | 'sora-2-pro'
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type VideoSize = '720x1280' | '1280x720' | '1024x1792' | '1792x1024'
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type VideoSeconds = '4' | '8' | '12'

interface VideoJob {
  id: string
  status: 'queued' | 'in_progress' | 'completed' | 'failed'
  progress?: number
  error?: {
    code: string
    message: string
  }
}

export default class VideoCreator implements MediaCreator {

  static getEngines(checkApiKey: boolean): MediaCreationEngine[] {
    const engines = []
    if (!checkApiKey || store.config.engines.openai.apiKey) {
      engines.push({ id: 'openai', name: engineNames.openai })
    }
    if (!checkApiKey || store.config.engines.google.apiKey) {
      engines.push({ id: 'google', name: engineNames.google })
    }
    if (!checkApiKey || store.config.engines.xai.apiKey) {
      engines.push({ id: 'xai', name: engineNames.xai })
    }
    if (!checkApiKey || store.config.engines.replicate.apiKey) {
      engines.push({ id: 'replicate', name: engineNames.replicate })
    }
    if (!checkApiKey || store.config.engines.falai.apiKey) {
      engines.push({ id: 'falai', name: engineNames.falai })
    }
    if (!checkApiKey || store.config.engines.venice?.apiKey) {
      engines.push({ id: 'venice', name: engineNames.venice })
    }
    return engines
  }

  getEngines(checkApiKey: boolean): MediaCreationEngine[] {
    return VideoCreator.getEngines(checkApiKey)
  }
   
  async execute(engine: string, model: string, parameters: anyDict, reference?: MediaReference[]): Promise<any> {
    const controller = new AbortController()
    this.activeAbort = controller
    const signal = controller.signal
    try {
      if (engine === 'replicate') {
        return await this.replicate(model, parameters, signal)
      } else if (engine === 'falai') {
        return await this.falai(model, parameters, reference, signal)
      } else if (engine == 'google') {
        return await this.google(model, parameters, reference, signal)
      } else if (engine == 'openai') {
        return await this.openai(model, parameters, reference, signal)
      } else if (engine == 'xai') {
        return await this.xai(model, parameters, reference, signal)
      } else if (engine == 'venice') {
        return await this.venice(model, parameters, reference, signal)
      } else {
        throw new Error('Unsupported engine')
      }
    } finally {
      if (this.activeAbort === controller) this.activeAbort = null
    }
  }

  private activeAbort: AbortController | null = null

  cancel(): void {
    this.activeAbort?.abort()
    this.activeAbort = null
  }

  private cancelledResult(): { cancelled: true, error: 'cancelled' } {
    return { cancelled: true, error: 'cancelled' }
  }

  private aborted(signal?: AbortSignal, error?: unknown): boolean {
    if (signal?.aborted) return true
    return !!error && typeof error === 'object' && (error as { name?: string }).name === 'AbortError'
  }

  private waitForPoll(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) return new Promise((resolve) => setTimeout(resolve, ms))
    if (signal.aborted) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      const onAbort = () => {
        clearTimeout(timer)
        resolve()
      }
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
  }

  async replicate(model: string, parameters: anyDict, signal?: AbortSignal): Promise<any> {

    if (signal?.aborted) return this.cancelledResult()

    try {

      // init
      const client = new Replicate({ auth: store.config.engines.replicate.apiKey });

      // call
      console.log(`[replicate] prompting model ${model}`)
      const output: FileOutput[] = await client.run(model as `${string}/${string}`, {
        input: parameters,
        signal,
      }) as FileOutput[];

      if (signal?.aborted) return this.cancelledResult()

      // save the content on disk
      const blob = Array.isArray(output) ? await output[0].blob() : await (output as FileOutput).blob()
      const type = blob.type?.split('/')[1] || 'mp4'
      const b64 = await this.blobToBase64(blob)
      const image = b64.split(',')[1]
      const fileUrl = saveFileContents(type, image)
      //console.log('[image] saved image to', fileUrl)

      // return an object
      return {
        url: fileUrl,
      }

    } catch (error) {
      if (this.aborted(signal, error)) return this.cancelledResult()
      throw error
    }

  }
  
  async falai(model: string, parameters: anyDict, reference?: MediaReference[], signal?: AbortSignal): Promise<anyDict> {

    try {

      if (signal?.aborted) return this.cancelledResult()

      // set api key
      fal.config({
        credentials: store.config.engines.falai.apiKey
      });

      // submit
      const response = await fal.subscribe(model, {
        abortSignal: signal,
        input: {
          ...(parameters.prompt ? { prompt: parameters.prompt } : {}),
          ...(reference ? { image_url: `data:${reference[0].mimeType};base64,${reference[0].contents}` } : {}),
        }
      })

      if (signal?.aborted) return this.cancelledResult()

      // download
      const video = response.data.video
      const fileUrl = download(video.url)
      return { url: fileUrl }

    } catch (error) {
      if (this.aborted(signal, error)) return this.cancelledResult()
      console.error("Error generating content:", error);
      return { error: error.message }
    }
  
  }
     
  async google(model: string, parameters: anyDict, reference?: MediaReference[], signal?: AbortSignal): Promise<anyDict> {

    const client = new GoogleGenAI({ apiKey: store.config.engines.google.apiKey })
  
    try {

      if (signal?.aborted) return this.cancelledResult()

      let operation = await client.models.generateVideos({
        model: model,
        prompt: parameters.prompt,
        // ...(reference && reference.mimeType.startsWith('image') ? { image: { imageBytes: reference.contents } } : {}),
        // ...(reference && reference.mimeType.startsWith('video') ? { video: { videoBytes: reference.contents } } : {}),
        config: {
          numberOfVideos: 1,
          //safetyFilterLevel: SafetyFilterLevel.BLOCK_NONE,
          personGeneration: PersonGeneration.ALLOW_ALL,
        },
      });

      if (signal?.aborted) return this.cancelledResult()

      while (!operation.done) {
        if (signal?.aborted) return this.cancelledResult()
        await this.waitForPoll(2500, signal)
        if (signal?.aborted) return this.cancelledResult()
        operation = await client.operations.getVideosOperation({operation: operation})
      }

      if (signal?.aborted) return this.cancelledResult()

      // if no video was generated, return an error
      if (!operation?.response?.generatedVideos?.[0]?.video) {
        if (operation?.response?.raiMediaFilteredReasons) {
          return { 
            error: `Google Generative AI finished with reason: ${operation.response.raiMediaFilteredReasons[0]}`
          }
        }
        return { 
          error: 'Google Generative AI returned no content'
        }
      }

      // save the content and return
      const videoUrl = operation.response.generatedVideos[0].video.uri
      const mimeType = operation.response.generatedVideos[0].video.mimeType || 'video/mp4'
      const fileUrl = await window.api.google.downloadMedia(videoUrl, mimeType)
      return { url: fileUrl, }

    } catch (error) {
      if (this.aborted(signal, error)) return this.cancelledResult()
      console.error("Error generating content:", error);
    }

    return { 
      error: 'Failed to generate image with Google Generative AI'
    }

  }

  async openai(model: string, parameters: anyDict, reference?: MediaReference[], signal?: AbortSignal): Promise<anyDict> {
    return this._openai('openai', store.config.engines.openai.apiKey, store.config.engines.openai.baseURL, model, parameters, reference, signal)
  }

  protected async _openai(name: string, apiKey: string, baseURL: string, model: string, parameters: anyDict, reference?: MediaReference[], signal?: AbortSignal): Promise<anyDict> {

    try {
      const endpoint = baseURL || 'https://api.openai.com'

      // Step 1: Create video generation job
      console.log(`[${name}] creating video with model ${model}`)
      const formData = new FormData()
      formData.append('prompt', parameters?.prompt || '')
      formData.append('model', model)

      if (parameters?.size) {
        formData.append('size', parameters.size)
      }

      if (parameters?.seconds) {
        formData.append('seconds', parameters.seconds)
      }

      // Handle image reference if provided
      if (reference?.[0]) {
        const binaryString = atob(reference[0].contents)
        const bytes = new Uint8Array(binaryString.length)
        for (let i = 0; i < bytes.length; i++) {
          bytes[i] = binaryString.charCodeAt(i)
        }
        const blob = new Blob([bytes], { type: reference[0].mimeType })
        formData.append('input_reference', blob, 'reference.jpg')
      }

      const createResponse = await fetch(`${endpoint}/v1/videos`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`
        },
        body: formData,
        signal,
      })

      if (!createResponse.ok) {
        const errorText = await createResponse.text()
        console.error(`[${name}] Video creation failed:`, errorText)
        throw new Error(`Video creation failed: ${createResponse.status} ${createResponse.statusText}`)
      }

      const videoJob: VideoJob = await createResponse.json()
      const videoId = videoJob.id

      if (!videoId) {
        throw new Error('Video API response missing id')
      }

      // Step 2: Poll for completion
      console.log(`[${name}] polling video status for ${videoId}`)
      const maxAttempts = 180 // 20-40 minutes with 10s intervals
      let currentJob = videoJob

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (signal?.aborted) return this.cancelledResult()

        if (currentJob.status === 'completed') {
          break
        }

        if (currentJob.status === 'failed') {
          console.error(`[${name}] Video generation failed`, currentJob.error)
          return {
            error: currentJob.error?.message || `Video generation failed with ${name} API`
          }
        }

        // Wait before next poll (10 seconds as recommended)
        await this.waitForPoll(10000, signal)
        if (signal?.aborted) return this.cancelledResult()

        const statusResponse = await fetch(`${endpoint}/v1/videos/${videoId}`, {
          headers: {
            'Authorization': `Bearer ${apiKey}`
          },
          signal,
        })

        if (!statusResponse.ok) {
          throw new Error(`Status check failed: ${statusResponse.status} ${statusResponse.statusText}`)
        }

        currentJob = await statusResponse.json()

        if (currentJob.progress) {
          console.log(`[${name}] video generation progress: ${currentJob.progress}%`)
        }
      }

      if (currentJob.status !== 'completed') {
        throw new Error('Video generation timed out')
      }

      if (signal?.aborted) return this.cancelledResult()

      // Step 3: Download the video content
      console.log(`[${name}] downloading video content`)
      const downloadResponse = await fetch(`${endpoint}/v1/videos/${videoId}/content`, {
        headers: {
          'Authorization': `Bearer ${apiKey}`
        },
        signal,
      })

      if (!downloadResponse.ok) {
        throw new Error(`Video download failed: ${downloadResponse.status} ${downloadResponse.statusText}`)
      }

      const blob = await downloadResponse.blob()
      const type = blob.type?.split('/')[1] || 'mp4'
      const b64 = await this.blobToBase64(blob)
      const content = b64.split(',')[1]
      const fileUrl = saveFileContents(type, content)

      return { url: fileUrl }

    } catch (error) {
      if (this.aborted(signal, error)) return this.cancelledResult()
      console.error(`[${name}] Video generation error:`, error)
      return { error: error.message || `Video generation failed with ${name} API` }
    }

  }

  async xai(model: string, parameters: anyDict, reference?: MediaReference[], signal?: AbortSignal): Promise<anyDict> {

    const apiKey = store.config.engines.xai.apiKey

    try {

      // build body
      console.log(`[xai] creating video with model ${model}`)
      const body: anyDict = {
        model: model,
        prompt: parameters?.prompt,
      }

      // optional parameters
      if (parameters?.duration) body.duration = parameters.duration
      if (parameters?.aspect_ratio) body.aspect_ratio = parameters.aspect_ratio
      if (parameters?.resolution) body.resolution = parameters.resolution

      // reference for image-to-video or video editing
      let isVideoEdit = false
      if (reference?.[0]) {
        if (reference[0].mimeType.startsWith('video')) {
          body.video = { url: `data:${reference[0].mimeType};base64,${reference[0].contents}` }
          isVideoEdit = true
        } else {
          body.image = { url: `data:${reference[0].mimeType};base64,${reference[0].contents}` }
        }
      }

      // Step 1: Submit generation/edit request
      // image-to-video uses /generations, video editing uses /edits
      const endpoint = isVideoEdit ? 'videos/edits' : 'videos/generations'
      if (signal?.aborted) return this.cancelledResult()

      const createResponse = await fetch(`${xAIBaseURL}/${endpoint}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      })

      if (!createResponse.ok) {
        const errorText = await createResponse.text()
        console.error('[xai] Video creation failed:', errorText)
        throw new Error(`Video creation failed: ${createResponse.status} ${createResponse.statusText}`)
      }

      const createResult = await createResponse.json()
      const requestId = createResult.request_id

      if (!requestId) {
        throw new Error('xAI Video API response missing request_id')
      }

      // Step 2: Poll for completion
      console.log(`[xai] polling video status for ${requestId}`)
      const maxAttempts = 180
      for (let attempt = 0; attempt < maxAttempts; attempt++) {

        if (signal?.aborted) return this.cancelledResult()
        await this.waitForPoll(10000, signal)
        if (signal?.aborted) return this.cancelledResult()

        const statusResponse = await fetch(`${xAIBaseURL}/videos/${requestId}`, {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
          },
          signal,
        })

        if (!statusResponse.ok) {
          throw new Error(`Status check failed: ${statusResponse.status} ${statusResponse.statusText}`)
        }

        const statusResult = await statusResponse.json()

        // completed: video object is present with url
        if (statusResult.video?.url) {
          if (signal?.aborted) return this.cancelledResult()
          const fileUrl = download(statusResult.video.url)
          return { url: fileUrl }
        }

        // still pending
        if (statusResult.status === 'pending') {
          console.log(`[xai] video generation status: pending`)
          continue
        }

        // unexpected status
        console.log(`[xai] video generation status:`, JSON.stringify(statusResult))
      }

      throw new Error('Video generation timed out')

    } catch (error) {
      if (this.aborted(signal, error)) return this.cancelledResult()
      console.error('[xai] Video generation error:', error)
      return { error: error.message || 'Video generation failed with xAI API' }
    }
  }

  // SDK-BASED IMPLEMENTATION (commented out - kept for reference)
  // This version requires OpenAI SDK which is incompatible with Electron
  //
  // async openai(model: string, parameters: anyDict, reference?: MediaReference[]): Promise<anyDict> {
  //   return this._openai('openai', store.config.engines.openai.apiKey, store.config.engines.openai.baseURL, model, parameters, reference)
  // }
  //
  // protected async _openai(name: string, apiKey: string, baseURL: string, model: string, parameters: anyDict, reference?: MediaReference[]): Promise<anyDict> {
  //   // init
  //   const client = new OpenAI({
  //     apiKey: apiKey,
  //     baseURL: baseURL,
  //     dangerouslyAllowBrowser: true
  //   })
  //
  //   // call
  //   console.log(`[${name}] prompting model ${model}`)
  //   const video = await client.videos.create({
  //     model: model as VideoModel,
  //     prompt: parameters?.prompt,
  //     ...(parameters?.seconds ? { seconds: parameters.seconds } : {}),
  //     ...(parameters?.size ? { size: parameters.size } : {}),
  //   })
  //
  //   // poll for completion
  //   let videoJob = video
  //   while (videoJob.status === 'queued' || videoJob.status === 'in_progress') {
  //     await new Promise(resolve => setTimeout(resolve, 2000))
  //     videoJob = await client.videos.retrieve(video.id)
  //   }
  //
  //   // check for errors
  //   if (videoJob.status === 'failed') {
  //     console.error(`[${name}] Video generation failed`, videoJob.error)
  //     return { error: videoJob.error?.message || `Video generation failed with ${name} API` }
  //   }
  //
  //   // download the content
  //   const response = await client.videos.downloadContent(videoJob.id)
  //   const blob = await response.blob()
  //   const type = blob.type?.split('/')[1] || 'mp4'
  //   const b64 = await this.blobToBase64(blob)
  //   const content = b64.split(',')[1]
  //   const fileUrl = saveFileContents(type, content)
  //
  //   return { url: fileUrl }
  // }

  async venice(model: string, parameters: anyDict, reference?: MediaReference[], signal?: AbortSignal): Promise<anyDict> {

    const apiKey = store.config.engines.venice?.apiKey || ''
    let owned: AbortController | null = null
    let abortSignal = signal
    if (!abortSignal) {
      owned = this.activeAbort ?? new AbortController()
      if (this.activeAbort == null) this.activeAbort = owned
      abortSignal = owned.signal
    }
    const sink = createIpcMediaSink(store.config.workspaceId)
    const meta = this.veniceModelMeta(model)
    const imageRequired = meta?.modelType === 'image-to-video' || (!meta && model.includes('image-to-video'))

    try {
      console.log(`[venice] creating video with model ${model}`)
      const url = await generateVeniceVideo({
        apiKey,
        model,
        prompt: parameters?.prompt || '',
        duration: parameters?.duration,
        resolution: parameters?.resolution,
        aspectRatio: parameters?.aspect_ratio,
        durations: meta?.durations,
        resolutions: meta?.resolutions,
        aspectRatios: meta?.aspectRatios,
        promptCharacterLimit: meta?.promptCharacterLimit,
        imageRequired,
        imageDataUrl: imageRequired ? this.veniceImageDataUrl(reference) : undefined,
      }, {
        sink,
        signal: abortSignal,
      })
      return { url }
    } catch (error) {
      try {
        await sink.abort()
      } catch {
        // The partial file may already be closed.
      }
      if (error instanceof VeniceVideoError && error.code === 'cancelled') {
        return this.cancelledResult()
      }
      if (this.aborted(abortSignal, error)) return this.cancelledResult()
      console.error('[venice] video generation failed')
      const message = error instanceof Error ? error.message : 'Video generation failed with Venice'
      return { error: message || 'Video generation failed with Venice' }
    } finally {
      if (owned && this.activeAbort === owned) this.activeAbort = null
    }
  }

  private veniceModelMeta(model: string): VeniceVideoModelMeta | undefined {
    const engine = store.config.engines.venice
    const lists = [
      ...(engine?.models?.video || []),
      ...(engine?.models?.videoEdit || []),
    ]
    const found = lists.find((item) => item.id === model) as unknown as { meta?: VeniceVideoModelMeta } | undefined
    return found?.meta
  }

  private veniceImageDataUrl(reference?: MediaReference[]): string | undefined {
    const image = reference?.find((item) => item?.mimeType?.startsWith('image/') && item.contents)
    if (!image) return undefined
    return `data:${image.mimeType};base64,${image.contents}`
  }

  async blobToBase64(blob: Blob): Promise<string>{
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onloadend = () => resolve(reader.result as string)
        reader.onerror = reject
        reader.readAsDataURL(blob)
    })
  }
}
