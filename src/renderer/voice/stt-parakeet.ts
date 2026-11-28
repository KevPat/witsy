
import { Configuration } from 'types/config'
import { STTEngine, ProgressCallback, ProgressInfo, TaskStatus, TranscribeResponse } from './stt'
import { getParakeetModel, ParakeetModel, ProgressInfo as ParakeetProgressInfo } from 'parakeet.js'

export default class STTParakeet implements STTEngine {

  config: Configuration
  model?: ParakeetModel
  ready = false

  static readonly models: { id: string; label: string }[] = [
    { id: 'istupakov/parakeet-tdt-0.6b-v2-onnx', label: 'Parakeet TDT 0.6B v2 (English, requires download)' },
    { id: 'istupakov/parakeet-tdt-0.6b-v3-onnx', label: 'Parakeet TDT 0.6B v3 (Multilingual, requires download)' },
  ]

  constructor(config: Configuration) {
    this.config = config
  }

  get name(): string {
    return 'parakeet'
  }

  isReady(): boolean {
    return this.ready
  }

  dispose(): void {
    this.model = undefined
    this.ready = false
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  isStreamingModel(model: string): boolean {
    return false
  }

  static requiresDownload(): boolean {
    return true
  }

  requiresDownload(): boolean {
    return STTParakeet.requiresDownload()
  }

  async initialize(callback?: ProgressCallback): Promise<void> {
    const modelId = this.config.stt.model || 'istupakov/parakeet-tdt-0.6b-v2-onnx'
    const useGpu = this.config.stt.parakeet?.gpu ?? false
    const backend = useGpu ? 'webgpu-hybrid' : 'wasm'

    try {
      callback?.({ status: 'initiate', name: modelId, file: '' } as ProgressInfo)

      const { urls, filenames } = await getParakeetModel(modelId, {
        backend,
        encoderQuant: useGpu ? 'fp32' : 'int8',
        decoderQuant: 'int8',
        preprocessor: 'nemo128',
        progress: ({ file, loaded, total }: ParakeetProgressInfo) => {
          callback?.({
            status: 'progress',
            name: modelId,
            file,
            progress: total > 0 ? (loaded / total) * 100 : 0,
            loaded,
            total
          } as ProgressInfo)
        }
      })

      this.model = await ParakeetModel.fromUrls({
        ...urls,
        filenames,
        backend,
        cpuThreads: navigator.hardwareConcurrency ? Math.max(1, navigator.hardwareConcurrency - 2) : 4,
        verbose: false
      })

      // warm up the model
      const warmupAudio = new Float32Array(16000)
      await this.model.transcribe(warmupAudio, 16000)

      this.ready = true
      callback?.({ status: 'ready' } as TaskStatus)

    } catch (error) {
      console.error(`[parakeet] ${backend} initialization failed:`, error)
      callback?.({ status: 'error', message: (error as Error).message })
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async transcribe(audioBlob: Blob, opts?: object): Promise<TranscribeResponse> {

    return new Promise((resolve, reject) => {

      let settled = false
      const fail = (error: unknown) => {
        console.error(error)
        if (settled) return
        settled = true
        reject(error)
      }
      const succeed = (value: TranscribeResponse) => {
        if (settled) return
        settled = true
        resolve(value)
      }

      try {

        // we need to decode the audio file to PCM Float32 @ 16kHz
        const fileReader = new FileReader()
        fileReader.onerror = () => {
          fail(fileReader.error ?? new Error('Failed to read audio file'))
        }
        fileReader.onloadend = async () => {
          let audioCTX: AudioContext | null = null
          try {
            const arrayBuffer = fileReader.result
            if (!(arrayBuffer instanceof ArrayBuffer)) {
              throw new Error('Failed to read audio file')
            }
            audioCTX = new AudioContext({
              sampleRate: 16000,
            })
            const decoded = await audioCTX.decodeAudioData(arrayBuffer)
            const pcmData = decoded.getChannelData(0)

            // transcribe with parakeet
            const result = await this.model!.transcribe(pcmData, 16000, {
              returnTimestamps: false,
              returnConfidences: false,
              frameStride: 2 // balance between speed and accuracy
            })

            succeed({ text: result.utterance_text || '' })
          } catch (error) {
            fail(error)
          } finally {
            // always close the audio context to free resources
            try {
              await audioCTX?.close()
            } catch (closeError) {
              console.error(closeError)
            }
          }

        }
        fileReader.readAsArrayBuffer(audioBlob)

      } catch (error) {
        fail(error)
      }
    })
  }

  async isModelDownloaded(model: string): Promise<boolean> {
    // parakeet.js uses IndexedDB for caching
    // check if the model files exist in IndexedDB
    try {
      const dbName = 'parakeet-models'
      const request = indexedDB.open(dbName)

      return new Promise((resolve) => {
        request.onsuccess = () => {
          const db = request.result
          if (!db.objectStoreNames.contains('models')) {
            db.close()
            resolve(false)
            return
          }

          const tx = db.transaction('models', 'readonly')
          const store = tx.objectStore('models')
          const getRequest = store.get(model)

          getRequest.onsuccess = () => {
            db.close()
            resolve(!!getRequest.result)
          }

          getRequest.onerror = () => {
            db.close()
            resolve(false)
          }
        }

        request.onerror = () => {
          resolve(false)
        }
      })
    } catch {
      return false
    }
  }

  async deleteModel(model: string): Promise<void> {
    try {
      const dbName = 'parakeet-models'
      const request = indexedDB.open(dbName)

      return new Promise((resolve) => {
        request.onsuccess = () => {
          const db = request.result
          if (!db.objectStoreNames.contains('models')) {
            db.close()
            resolve()
            return
          }

          const tx = db.transaction('models', 'readwrite')
          const store = tx.objectStore('models')
          store.delete(model)

          tx.oncomplete = () => {
            db.close()
            resolve()
          }

          tx.onerror = () => {
            db.close()
            resolve()
          }
        }

        request.onerror = () => {
          resolve()
        }
      })
    } catch {
      // ignore errors
    }
  }

  async deleteAllModels(): Promise<void> {
    try {
      await indexedDB.deleteDatabase('parakeet-models')
    } catch {
      // ignore errors
    }
  }

}
