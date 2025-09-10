import * as provider from './provider'
import * as types from './types'
import * as utils from './utils'
import * as oainew from './oainew'

// A simple echo provider that returns the original request body
export class impl implements provider.Provider {
    private rawBody: string | undefined

    async convertToProviderRequest(request: Request, baseUrl: string, apiKey: string): Promise<Request> {
        // Capture the exact original body for echo
        this.rawBody = await request.text()

        // Try to forward via oainew, forcing non-stream for easier aggregation
        try {
            const parsed = JSON.parse(this.rawBody)
            const forwardedBody = { ...parsed, stream: false }
            const modReq = new Request(request, {
                method: 'POST',
                headers: request.headers,
                body: JSON.stringify(forwardedBody)
            })
            const forwarder = new oainew.impl()
            return await forwarder.convertToProviderRequest(modReq, baseUrl, apiKey)
        } catch {
            // Fallback: pass through to oainew with original request if body isn't JSON
            const forwarder = new oainew.impl()
            const passthroughReq = new Request(request, { method: 'POST', headers: request.headers, body: this.rawBody })
            return await forwarder.convertToProviderRequest(passthroughReq, baseUrl, apiKey)
        }
    }

    async convertToClaudeResponse(providerResponse: Response): Promise<Response> {
        // Convert provider response to Claude style using oainew
        const forwarder = new oainew.impl()
        const converted = await forwarder.convertToClaudeResponse(providerResponse)
        const convertedText = await converted.text()

        const separator = '==='.repeat(10) // 10*===
        const combined = `${this.rawBody ?? ''}\n${separator}\n${convertedText}`

        const claudeResponse: types.ClaudeResponse = {
            id: utils.generateId(),
            type: 'message',
            role: 'assistant',
            content: [
                {
                    type: 'text',
                    text: combined
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
