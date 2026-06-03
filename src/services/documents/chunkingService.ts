import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters'
import { db } from '@/lib/db'
import { documents, documentChunks } from '@/drizzle/schema'
import { eq } from 'drizzle-orm'
import { logger, logDocumentChunking, logError } from '@/lib/logger'

/**
 * 最大chunks数量限制
 * 超过此限制会截断并告警
 */
const MAX_CHUNKS = 10000

/**
 * 分块错误
 */
export class ChunkingError extends Error {
  constructor(message: string, public cause?: Error) {
    super(message)
    this.name = 'ChunkingError'
  }
}

/**
 * 分块结果
 */
export interface ChunkResult {
  id: string
  chunkIndex: number
  content: string
  length: number
}

/**
 * 文档分块服务
 * 
 * @param documentId - 文档ID
 * @returns 分块结果数组
 */
export async function chunkDocument(
  documentId: string
): Promise<ChunkResult[]> {
  try {
    // 1. 获取文档记录
    const [document] = await db.select()
      .from(documents)
      .where(eq(documents.id, documentId))
    
    if (!document) {
      throw new ChunkingError('文档不存在')
    }

    // 2. 检查文档状态:解析完成后为 EMBEDDING（新流程）或 READY（重新处理已就绪文档）
    if (document.status !== 'READY' && document.status !== 'EMBEDDING') {
      throw new ChunkingError(
        `文档状态错误: ${document.status}, 期望: EMBEDDING 或 READY`
      )
    }

    // 3. 更新状态为EMBEDDING
    await db.update(documents)
      .set({ status: 'EMBEDDING' })
      .where(eq(documents.id, documentId))

    // 4. 获取已解析的文本内容
    // 从metadata.content获取(假设Story 2.3存储在这里)
    const metadata = document.metadata as Record<string, unknown> | null
    const parsedContent = metadata?.content as string
    
    // 检查内容是否存在
    if (!parsedContent) {
      throw new ChunkingError('文档未解析')
    }

    // 检查内容是否为空或仅包含空白字符
    const trimmedContent = parsedContent.trim()
    if (trimmedContent.length === 0) {
      throw new ChunkingError('文档内容为空，无法处理')
    }

    logger.info({
      documentId,
      contentLength: trimmedContent.length,
      action: 'chunk_start'
    }, 'Document chunking started')

    // 5. 配置分块器
    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: 1000,        // 每块约1000 tokens
      chunkOverlap: 200,      // 重叠200 tokens保持上下文
      separators: [
        '\n\n',   // 优先按段落
        '\n',     // 其次按换行
        '. ',     // 英文句号
        '。',     // 中文句号
        ' ',      // 空格
        ''        // 字符级别
      ]
    })
    
    // 6. 执行分块
    const chunkStartTime = Date.now()
    let allChunks = await splitter.createDocuments([trimmedContent])
    const originalChunksCount = allChunks.length
    const chunkTime = Date.now() - chunkStartTime
    
    logger.info({
      documentId,
      chunksCount: originalChunksCount,
      chunkTime,
      action: 'chunk_complete'
    }, 'Document chunking completed')

    // 7. 检查是否超过最大限制
    let truncated = false
    if (originalChunksCount > MAX_CHUNKS) {
      logDocumentChunking({
        documentId,
        chunksCount: originalChunksCount,
        truncated: true,
        limit: MAX_CHUNKS
      })
      
      allChunks = allChunks.slice(0, MAX_CHUNKS) // 截断
      truncated = true
    } else {
      logDocumentChunking({
        documentId,
        chunksCount: originalChunksCount,
        chunkTime
      })
    }

    // 8. 保存到数据库
    const chunkRecords = await db.insert(documentChunks).values(
      allChunks.map((chunk, index) => ({
        documentId,
        chunkIndex: index,
        content: chunk.pageContent,
        embeddingId: '', // 稍后由embeddingService填充
        metadata: {
          length: chunk.pageContent.length,
          ...(truncated ? { truncated: true } : {})
        }
      }))
    ).returning()

    // 9. 如果截断，在文档metadata中记录
    if (truncated) {
      await db.update(documents)
        .set({
          metadata: {
            ...metadata,
            chunking: {
              truncated: true,
              originalChunksCount,
              storedChunksCount: MAX_CHUNKS
            }
          }
        })
        .where(eq(documents.id, documentId))
    }
    
    // 10. 返回分块结果
    return chunkRecords.map(record => ({
      id: record.id,
      chunkIndex: record.chunkIndex,
      content: record.content,
      length: record.content.length
    }))

  } catch (error) {
    // 获取当前文档以保留现有metadata
    const [currentDoc] = await db.select()
      .from(documents)
      .where(eq(documents.id, documentId))

    // 判断错误类型
    let errorType = 'CHUNKING_ERROR'
    if (error instanceof ChunkingError) {
      if (error.message.includes('文档内容为空')) {
        errorType = 'EMPTY_CONTENT'
      }
    }

    // 记录错误日志
    logError(error, {
      documentId,
      errorType,
      documentStatus: currentDoc?.status,
      action: 'chunking_error'
    })

    // 更新文档状态为FAILED，保留现有metadata
    await db.update(documents)
      .set({
        status: 'FAILED',
        metadata: {
          ...(currentDoc?.metadata as Record<string, unknown> || {}),
          error: {
            type: errorType,
            message: error instanceof Error ? error.message : '未知错误',
            timestamp: new Date().toISOString()
          }
        }
      })
      .where(eq(documents.id, documentId))

    if (error instanceof ChunkingError) {
      throw error
    }
    throw new ChunkingError('分块失败', error as Error)
  }
}
