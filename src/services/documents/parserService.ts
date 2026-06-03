import mammoth from 'mammoth'
import chardet from 'chardet'
import { db } from '@/lib/db'
import { documents } from '@/drizzle/schema'
import { eq } from 'drizzle-orm'
import { StorageService } from './storageService'
import { ParseResult, ParseError } from './types'
import { logger, logDocumentParsing, logValidationWarning } from '@/lib/logger'
// 使用 legacy 构建：适配 Node/serverless 服务端环境（主入口为浏览器版，会触发 fake worker 加载失败）
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.js'

// 重新导出 ParseError 供 API 路由使用
export { ParseError } from './types'
export type { ParseResult } from './types'

// 解析超时时间(30秒)
const PARSE_TIMEOUT = 30000

/**
 * 超时控制包装器
 */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new ParseError('TIMEOUT_ERROR', errorMessage)), timeoutMs)
    )
  ])
}

/**
 * 主解析函数
 * 
 * @param documentId - 文档ID
 * @returns 解析后的文本内容和元信息
 * @throws ParseError - 解析失败时抛出
 */
export async function parseDocument(
  documentId: string
): Promise<ParseResult> {
  // 记录开始时间和内存使用
  const startTime = Date.now()
  const startMemory = process.memoryUsage().heapUsed

  // 1. 获取文档记录
  const [document] = await db.select()
    .from(documents)
    .where(eq(documents.id, documentId))
  
  if (!document) {
    throw new ParseError('PARSE_ERROR', '文档不存在')
  }

  // 2. 更新状态为PARSING
  await db.update(documents)
    .set({ 
      status: 'PARSING',
      metadata: { startTime: new Date().toISOString() }
    })
    .where(eq(documents.id, documentId))

  try {
    // 3. 从Storage下载文件
    const fileArrayBuffer = await StorageService.getFile(document.storagePath)
    
    if (!fileArrayBuffer) {
      throw new ParseError('PARSE_ERROR', '文件不存在或已损坏')
    }

    // 转换ArrayBuffer为Buffer
    const fileBuffer = Buffer.from(fileArrayBuffer)

    // 4. 根据文件类型选择解析器(带超时控制)
    const parsePromise = (async () => {
      switch (document.fileType) {
        case 'application/pdf':
          return await parsePDF(fileBuffer)
        
        case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
          return await parseWord(fileBuffer)
        
        case 'text/markdown':
        case 'text/plain':
          return await parseText(fileBuffer)
        
        default:
          throw new ParseError(
            'UNSUPPORTED_FORMAT', 
            `不支持的文件类型: ${document.fileType}`
          )
      }
    })()

    const result = await withTimeout(
      parsePromise,
      PARSE_TIMEOUT,
      `解析超时(>${PARSE_TIMEOUT/1000}秒),请尝试减小文件大小`
    )

    // 5. 计算解析性能指标
    const parseTime = Date.now() - startTime
    const endMemory = process.memoryUsage().heapUsed
    const memoryUsed = endMemory - startMemory

    // 5.5 清理null字符 - PostgreSQL JSON不支持\u0000
    // 统计并记录清理的null字符数量，用于监控解析质量
    const nullCharCount = (result.content.match(/\u0000/g) || []).length
    const cleanContent = result.content.replace(/\u0000/g, '')
    
    if (nullCharCount > 0) {
      logValidationWarning({
        documentId,
        reason: 'null_chars_cleaned',
        context: {
          nullCharsRemoved: nullCharCount,
          fileType: document.fileType
        }
      })
    }
    
    const cleanMetadata = { ...result.metadata }
    // 清理metadata中所有字符串字段的null字符
    Object.keys(cleanMetadata).forEach(key => {
      if (typeof cleanMetadata[key] === 'string') {
        const nullCount = (cleanMetadata[key].match(/\u0000/g) || []).length
        if (nullCount > 0) {
          logger.warn({
            documentId,
            field: `metadata.${key}`,
            nullCharsRemoved: nullCount,
            action: 'validation_warn'
          }, `Metadata field cleaned`)
        }
        cleanMetadata[key] = cleanMetadata[key].replace(/\u0000/g, '')
      }
    })

    // 6. 更新数据库(成功)
    await db.update(documents)
      .set({
        // 解析完成进入 EMBEDDING 中间态（而非 READY）：
        // 避免前端轮询在「解析完但未向量化」瞬间看到 READY 而提前停止刷新，导致文档块卡在 0。
        // 最终的 READY 由 embeddingService 在向量化完成后统一设置。
        status: 'EMBEDDING',
        contentLength: cleanContent.length,
        parsedAt: new Date(),
        metadata: {
          ...cleanMetadata,
          content: cleanContent, // 存储清理后的内容供分块使用
          parseTime,
          memoryUsed,
          parsedAt: new Date().toISOString(),
          // 记录是否进行了null字符清理
          ...(nullCharCount > 0 && { 
            nullCharsRemoved: nullCharCount,
            contentCleaned: true 
          })
        }
      })
      .where(eq(documents.id, documentId))

    // 记录解析成功
    logDocumentParsing({
      documentId,
      fileType: document.fileType,
      contentLength: cleanContent.length,
      parseTime,
      success: true
    })

    // 返回清理后的结果
    return {
      ...result,
      content: cleanContent,
      contentLength: cleanContent.length
    }

  } catch (error) {
    // 7. 更新数据库(失败)
    const errorType = error instanceof ParseError 
      ? error.type 
      : 'PARSE_ERROR'
    
    const errorMessage = error instanceof Error 
      ? error.message 
      : '未知错误'

    await db.update(documents)
      .set({
        status: 'FAILED',
        metadata: {
          error: {
            type: errorType,
            message: errorMessage,
            timestamp: new Date().toISOString()
          }
        }
      })
      .where(eq(documents.id, documentId))

    // 记录解析失败
    logDocumentParsing({
      documentId,
      fileType: document.fileType,
      success: false,
      error: errorMessage
    })

    throw error
  }
}

/**
 * 验证PDF魔术字节
 */
function isPDFValid(buffer: Buffer): boolean {
  if (buffer.length < 5) return false
  const header = buffer.slice(0, 5).toString('ascii')
  return header === '%PDF-'
}

/**
 * 解析PDF文档 (使用 PDF.js - 纯JS实现,适合serverless环境)
 */
async function parsePDF(buffer: Buffer): Promise<ParseResult> {
  try {
    // 验证PDF格式
    if (!isPDFValid(buffer)) {
      throw new ParseError('PARSE_ERROR', 'PDF文件格式无效')
    }

    // 将 Buffer 转换为 Uint8Array
    const uint8Array = new Uint8Array(buffer)
    
    // 加载 PDF 文档
    const loadingTask = pdfjsLib.getDocument({
      data: uint8Array,
      // 禁用字体加载以提高性能
      disableFontFace: true,
      // 禁用范围请求
      disableRange: true,
      // 禁用流式加载
      disableStream: true
    })
    
    const pdfDocument = await loadingTask.promise
    const numPages = pdfDocument.numPages
    
    // 限制最大页数(防止超大PDF)
    const maxPages = Math.min(numPages, 1000)
    
    // 提取所有页面的文本
    const textPromises: Promise<string>[] = []
    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      textPromises.push(extractPageText(pdfDocument, pageNum))
    }
    
    const pageTexts = await Promise.all(textPromises)
    const content = pageTexts.join('\n\n')
    
    // 验证内容
    if (!content || content.trim().length === 0) {
      throw new ParseError('PARSE_ERROR', 'PDF文档为空或无法提取文本')
    }
    
    // 获取元数据
    const metadata = await pdfDocument.getMetadata()
    
    // 安全提取元信息（PDF.js metadata.info 可能为 null 或不同类型）
    const info = metadata.info as Record<string, unknown> | null | undefined
    const result = {
      totalPages: numPages,
      title: (info && typeof info.Title === 'string') ? info.Title : undefined,
      author: (info && typeof info.Author === 'string') ? info.Author : undefined,
      creator: (info && typeof info.Creator === 'string') ? info.Creator : undefined,
      creationDate: (info && typeof info.CreationDate === 'string') ? info.CreationDate : undefined,
      wordCount: countWords(content)
    }

    // 清理资源
    await pdfDocument.cleanup()
    await pdfDocument.destroy()

    return {
      content: content.trim(),
      contentLength: content.length,
      metadata: result
    }

  } catch (error) {
    // 处理PDF特定错误
    if (error instanceof Error) {
      if (error.message.includes('encrypted') || error.message.includes('password')) {
        throw new ParseError('ENCRYPTION_ERROR', 'PDF文档已加密,无法读取')
      }
      if (error.message.includes('Invalid PDF') || error.message.includes('invalid')) {
        throw new ParseError('PARSE_ERROR', 'PDF文件损坏或格式无效')
      }
    }
    
    if (error instanceof ParseError) {
      throw error
    }
    
    throw new ParseError('PARSE_ERROR', `PDF解析失败: ${error instanceof Error ? error.message : '未知错误'}`)
  }
}

/**
 * 从PDF页面提取文本
 */
async function extractPageText(pdfDocument: pdfjsLib.PDFDocumentProxy, pageNum: number): Promise<string> {
  try {
    const page = await pdfDocument.getPage(pageNum)
    const textContent = await page.getTextContent()
    
    // 提取所有文本项
    const textItems = textContent.items
      .map((item) => {
        // PDF.js TextItem 可能有不同的类型，安全提取 str 属性
        if ('str' in item) {
          return (item as { str: string }).str
        }
        return ''
      })
      .filter((str: string) => str.trim().length > 0)
    
    return textItems.join(' ')
  } catch (error) {
    logger.warn({ pageNum, error, action: 'warning' }, `Failed to extract text from page ${pageNum}`)
    return ''
  }
}

/**
 * 解析Word文档(.docx)
 */
async function parseWord(buffer: Buffer): Promise<ParseResult> {
  try {
    // 使用mammoth提取纯文本(保留段落结构)
    const result = await mammoth.extractRawText({ buffer })
    
    const content = result.value

    // 验证内容
    if (!content || content.trim().length === 0) {
      throw new ParseError('PARSE_ERROR', 'Word文档为空或无法提取文本')
    }

    // 统计段落和单词
    const paragraphs = content.split(/\n\n+/).filter(p => p.trim().length > 0)
    
    const metadata = {
      paragraphCount: paragraphs.length,
      wordCount: countWords(content),
      messages: result.messages.length > 0 ? result.messages : undefined
    }

    return {
      content: content.trim(),
      contentLength: content.length,
      metadata
    }

  } catch (error) {
    // 处理Word特定错误
    if (error instanceof Error) {
      if (error.message.includes('not a valid zip') || error.message.includes('End of Central Directory Record not found')) {
        throw new ParseError('PARSE_ERROR', 'Word文件损坏或不是有效的.docx格式')
      }
    }
    
    if (error instanceof ParseError) {
      throw error
    }
    
    throw new ParseError('PARSE_ERROR', `Word文档解析失败: ${error instanceof Error ? error.message : '未知错误'}`)
  }
}

/**
 * 解析纯文本(Markdown/TXT)
 */
async function parseText(buffer: Buffer): Promise<ParseResult> {
  try {
    // 检测字符编码
    const detectedEncoding = chardet.detect(buffer)
    const encoding = detectedEncoding || 'utf-8'
    
    // 转换为字符串
    const content = buffer.toString(encoding as BufferEncoding)

    // 验证内容
    if (!content || content.trim().length === 0) {
      throw new ParseError('PARSE_ERROR', '文本文件为空')
    }

    // 统计行数和单词
    const lines = content.split('\n')
    
    const metadata = {
      lineCount: lines.length,
      wordCount: countWords(content),
      encoding
    }

    return {
      content: content.trim(),
      contentLength: content.length,
      metadata
    }

  } catch (error) {
    if (error instanceof ParseError) {
      throw error
    }
    
    throw new ParseError('PARSE_ERROR', `文本文件解析失败: ${error instanceof Error ? error.message : '未知错误'}`)
  }
}

/**
 * 统计单词数(支持中英文)
 */
function countWords(text: string): number {
  // 移除多余空白
  const cleaned = text.trim().replace(/\s+/g, ' ')
  
  // 英文单词数
  const englishWords = cleaned.match(/[a-zA-Z]+/g)?.length || 0
  
  // 中文字符数(近似为词数)
  const chineseChars = cleaned.match(/[\u4e00-\u9fa5]/g)?.length || 0
  
  return englishWords + chineseChars
}

