import * as provider from './provider'
import * as types from './types'
import * as utils from './utils'

// A simple echo provider that returns the original request body
export class impl implements provider.Provider {
    async convertToProviderRequest(request: Request, _baseUrl: string, _apiKey: string): Promise<Request> {
        // Read the raw request body text exactly as sent
        const rawBody = await request.text()

        // Use a data URL so fetch() returns a Response with this exact text
        const dataUrl = `data:text/plain;charset=utf-8,${encodeURIComponent(rawBody)}`
        return new Request(dataUrl, { method: 'GET' })
    }

    async convertToClaudeResponse(providerResponse: Response): Promise<Response> {
        const originalText = await providerResponse.text()

        const claudeResponse: types.ClaudeResponse = {
            id: utils.generateId(),
            type: 'message',
            role: 'assistant',
            content: [
                {
                    type: 'text',
                    text: originalText
                }
            ],
            stop_reason: 'end_turn'
        }

        return new Response(JSON.stringify(claudeResponse), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        })
    }
}

