import * as types from './types'
import * as provider from './provider'
import * as utils from './utils'

export class impl implements provider.Provider {
    async convertToProviderRequest(request: Request, baseUrl: string, apiKey: string): Promise<Request> {
        const claudeRequest = (await request.json()) as types.ClaudeRequest
        const responsesRequest = this.convertToResponsesRequestBody(claudeRequest)

        // 使用新的 Responses API 端点
        const finalUrl = utils.buildUrl(baseUrl, 'v1/responses')

        const headers = new Headers(request.headers)
        headers.set('Authorization', `Bearer ${apiKey}`)
        headers.set('Content-Type', 'application/json')

        return new Request(finalUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(responsesRequest)
        })
    }

    async convertToClaudeResponse(responsesResponse: Response): Promise<Response> {
        if (!responsesResponse.ok) {
            return responsesResponse
        }

        const contentType = responsesResponse.headers.get('content-type') || ''
        const isStream = contentType.includes('text/event-stream')

        if (isStream) {
            return this.convertStreamResponse(responsesResponse)
        } else {
            return this.convertNormalResponse(responsesResponse)
        }
    }

    private convertToResponsesRequestBody(claudeRequest: types.ClaudeRequest): types.OpenAIResponsesRequest {
        const responsesRequest: types.OpenAIResponsesRequest = {
            model: claudeRequest.model,
            input: this.convertMessages(claudeRequest.messages),
            stream: claudeRequest.stream
        }

        // 添加推理模型参数
        if (claudeRequest.model.includes('o1') || claudeRequest.model.includes('o3') || claudeRequest.model.includes('gpt-5')) {
            responsesRequest.reasoning_effort = "medium"
        }

        // 添加流式选项
        if (claudeRequest.stream) {
            responsesRequest.stream_options = {
                include_usage: true
            }
        }

        if (claudeRequest.tools && claudeRequest.tools.length > 0) {
            responsesRequest.tools = claudeRequest.tools.map(tool => ({
                type: 'function',
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: utils.cleanJsonSchema(tool.input_schema),
                    strict: true
                }
            }))
            responsesRequest.tool_choice = "auto"
        }

        if (claudeRequest.temperature !== undefined) {
            // 对于推理模型(gpt-5, o1, o3)，可能有不同的温度处理
            if (claudeRequest.model.includes('gpt-5')) {
                // gpt-5可能有不同的温度范围或处理方式
                responsesRequest.temperature = claudeRequest.temperature
            } else {
                responsesRequest.temperature = claudeRequest.temperature
            }
        }

        if (claudeRequest.max_tokens !== undefined) {
            // 新的Responses API使用 max_completion_tokens 而不是 max_tokens
            responsesRequest.max_completion_tokens = claudeRequest.max_tokens
        }

        return responsesRequest
    }

    // 复用原来的消息转换逻辑
    private convertMessages(claudeMessages: types.ClaudeMessage[]): types.OpenAIMessage[] {
        const openaiMessages: types.OpenAIMessage[] = []
        const toolCallMap = new Map<string, string>()

        for (const message of claudeMessages) {
            if (typeof message.content === 'string') {
                openaiMessages.push({
                    role: message.role === 'assistant' ? 'assistant' : 'user',
                    content: message.content
                })
                continue
            }

            const textContents: string[] = []
            const toolCalls: types.OpenAIToolCall[] = []
            const toolResults: Array<{ tool_call_id: string; content: string }> = []

            for (const content of message.content) {
                switch (content.type) {
                    case 'text':
                        textContents.push(content.text)
                        break
                    case 'tool_use':
                        toolCallMap.set(content.id, content.id)
                        toolCalls.push({
                            id: content.id,
                            type: 'function',
                            function: {
                                name: content.name,
                                arguments: JSON.stringify(content.input)
                            }
                        })
                        break
                    case 'tool_result':
                        toolResults.push({
                            tool_call_id: content.tool_use_id,
                            content:
                                typeof content.content === 'string' ? content.content : JSON.stringify(content.content)
                        })
                        break
                }
            }

            if (textContents.length > 0 || toolCalls.length > 0) {
                const openaiMessage: types.OpenAIMessage = {
                    role: message.role === 'assistant' ? 'assistant' : 'user',
                    content: textContents.length > 0 ? textContents.join('\n') : null
                }

                if (toolCalls.length > 0) {
                    openaiMessage.tool_calls = toolCalls
                }

                openaiMessages.push(openaiMessage)
            }

            for (const toolResult of toolResults) {
                openaiMessages.push({
                    role: 'tool',
                    tool_call_id: toolResult.tool_call_id,
                    content: toolResult.content
                })
            }
        }

        return openaiMessages
    }

    private async convertNormalResponse(responsesResponse: Response): Promise<Response> {
        const responsesData = (await responsesResponse.json()) as types.OpenAIResponsesOutput

        const claudeResponse: types.ClaudeResponse = {
            id: utils.generateId(),
            type: 'message',
            role: 'assistant',
            content: []
        }

        if (responsesData.output && responsesData.output.length > 0) {
            let hasToolUse = false

            for (const item of responsesData.output) {
                if (item.type === 'text' && item.content) {
                    claudeResponse.content.push({
                        type: 'text',
                        text: item.content
                    })
                } else if (item.type === 'function_call') {
                    hasToolUse = true
                    claudeResponse.content.push({
                        type: 'tool_use',
                        id: item.call_id || utils.generateId(),
                        name: item.name || '',
                        input: item.arguments ? JSON.parse(item.arguments) : {}
                    })
                }
            }

            if (hasToolUse) {
                claudeResponse.stop_reason = 'tool_use'
            } else {
                claudeResponse.stop_reason = 'end_turn'
            }
        }

        if (responsesData.usage) {
            claudeResponse.usage = {
                input_tokens: responsesData.usage.prompt_tokens,
                output_tokens: responsesData.usage.completion_tokens
            }
        }

        return new Response(JSON.stringify(claudeResponse), {
            status: responsesResponse.status,
            headers: {
                'Content-Type': 'application/json'
            }
        })
    }

    private async convertStreamResponse(responsesResponse: Response): Promise<Response> {
        // 复用原来的流式响应处理逻辑，但适配新的 Responses API 格式
        const toolCallAccumulator = new Map<number, { id?: string; name?: string; arguments?: string }>()
        
        return utils.processProviderStream(responsesResponse, (jsonStr, textBlockIndex, toolUseBlockIndex) => {
            const responsesData = JSON.parse(jsonStr) as types.OpenAIResponsesStreamResponse
            if (!responsesData.choices || responsesData.choices.length === 0) {
                return null
            }

            const choice = responsesData.choices[0]
            const delta = choice.delta
            const events: string[] = []
            let currentTextIndex = textBlockIndex
            let currentToolIndex = toolUseBlockIndex

            if (delta.content) {
                events.push(...utils.processTextPart(delta.content, currentTextIndex))
                currentTextIndex++
            }

            if (delta.tool_calls) {
                for (const toolCall of delta.tool_calls) {
                    const toolIndex = toolCall.index ?? 0
                    
                    // 获取或创建工具调用累积器
                    if (!toolCallAccumulator.has(toolIndex)) {
                        toolCallAccumulator.set(toolIndex, {})
                    }
                    const accumulated = toolCallAccumulator.get(toolIndex)!
                    
                    // 累积数据
                    if (toolCall.id) {
                        accumulated.id = toolCall.id
                    }
                    if (toolCall.function?.name) {
                        accumulated.name = toolCall.function.name
                    }
                    if (toolCall.function?.arguments) {
                        accumulated.arguments = (accumulated.arguments || '') + toolCall.function.arguments
                    }
                    
                    // 检查是否收集完整，并且arguments是有效JSON
                    if (accumulated.name && accumulated.arguments) {
                        try {
                            const args = JSON.parse(accumulated.arguments)
                            events.push(
                                ...utils.processToolUsePart(
                                    {
                                        name: accumulated.name,
                                        args: args
                                    },
                                    currentToolIndex
                                )
                            )
                            currentToolIndex++
                            // 清除已处理的工具调用
                            toolCallAccumulator.delete(toolIndex)
                        } catch (e) {
                            // JSON还不完整，继续累积
                        }
                    }
                }
            }

            return {
                events,
                textBlockIndex: currentTextIndex,
                toolUseBlockIndex: currentToolIndex
            }
        })
    }
}