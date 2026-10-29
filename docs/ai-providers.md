# AI provider and model selection

Administrators can choose the AI service under **Integrations → AI provider → Configure** or **Settings → AI assistant → Choose provider & model**. The same store tools, customer authorization, explicit checkout confirmation, payment verification, daily-turn cap, and tool-call cap apply to every provider.

## Configure from the panel

1. Select a provider from the dropdown.
2. Enter that provider's API key. A blank key preserves its stored value. Local Ollama and loopback-compatible endpoints can run without a key; remote endpoints require one.
3. For Ollama or a custom compatible service, enter the API base URL including its prefix, normally `/v1`. The URL is resolved from the backend machine. Cloud endpoints require HTTPS; HTTP is accepted only for `localhost`, `127.0.0.1`, and IPv6 loopback.
4. Choose **Load available models**. This explicitly contacts the selected service using the entered or stored key, even while the rest of the app is in demo mode. Only model-list GET requests are made; no text generation is requested.
5. Select a model from the returned list. Alternatively, enable **Enter a model ID manually**. Choose a model with function/tool calling. Discovery verifies the returned catalog, not generation capability, English/Telugu quality, pricing, or checkout behavior. OpenRouter models that explicitly report no tool support and Gemini models without `generateContent` are filtered out.
6. Save. The selected service, model, and provider-specific credentials are written to the environment file. The current running selection stays unchanged until the **API and worker are restarted**.

The panel displays the running provider/model separately from the saved selection. Switching providers retains the previous provider's credentials and model, so switching back does not require re-entering them. Secrets are never returned by settings, model discovery, system status, or audit records. Discovery can use freshly entered credentials without saving them first.

The local mock app can be restarted with `npm run restart:local`. Live deployments require restarting both managed processes through their deployment manager. Demo conversations remain simulated; the selected provider handles conversations when `APP_MODE=live`. Live mode still requires WooCommerce, MySQL, WhatsApp/Flow, HTTPS, and the other staging prerequisites, but only the selected AI provider's key and model are required.

## Providers and environment fields

| Selection (`AI_PROVIDER`) | Key | Model | Protocol |
|---|---|---|---|
| `openai` | `OPENAI_API_KEY` | `OPENAI_MODEL` | Native Responses |
| `anthropic` | `ANTHROPIC_API_KEY` | `ANTHROPIC_MODEL` | Native Claude Messages |
| `gemini` | `GEMINI_API_KEY` | `GEMINI_MODEL` | Native Gemini GenerateContent |
| `deepseek` | `DEEPSEEK_API_KEY` | `DEEPSEEK_MODEL` | Compatible Chat Completions |
| `groq` | `GROQ_API_KEY` | `GROQ_MODEL` | Compatible Chat Completions |
| `openrouter` | `OPENROUTER_API_KEY` | `OPENROUTER_MODEL` | Compatible Chat Completions |
| `ollama` | `OLLAMA_API_KEY` (optional locally) | `OLLAMA_MODEL` | Compatible Chat Completions |
| `compatible` | `AI_API_KEY` (optional locally) | `AI_MODEL` | Compatible Chat Completions |

`AI_PROVIDER` defaults to `openai`, preserving the existing environment format. Custom endpoints use `AI_BASE_URL`. Ollama uses `OLLAMA_BASE_URL`, defaulting to `http://127.0.0.1:11434/v1`; its service and a tool-capable model must already be available. The app does not install or download models. Anthropic's API header version is configurable through `ANTHROPIC_VERSION`, defaulting to the documented `2026-10-21` version used during implementation.

Direct native integrations use their fixed official endpoints. Custom endpoint settings cannot redirect a cloud provider's stored key to a different host; custom services have their own separate key field. Automatic provider/model fallback is not implemented. A failure remains a failure and follows the existing retry/human-review behavior.

## Protocol and testing notes

The agent retains its internal message/tool interface. Provider adapters translate tools and tool results into native payloads. Claude assistant content, Gemini thought signatures/function IDs, compatible chat reasoning metadata, and OpenAI response items are preserved within the current turn. Every turn takes one provider/model/credential snapshot; changing shared configuration cannot change protocol midway through that turn. Thinking/reasoning blocks are not used as the customer-visible reply or stored in conversation messages.

Model discovery is bounded to five pages for paginated native APIs and 1,000 unique models in the returned UI list. The panel identifies partial lists and always supports manual IDs. A read access check using active credentials verifies the selected model's identity/list membership; it does not invoke a model or prove tool execution works. All provider APIs can change, and actual account permissions, tool support, model availability, token-budget compatibility, and quality need staging checks with the selected model.

Contract tests mock provider HTTP responses for Claude, Gemini, and compatible services, including tool continuations and credential isolation. Configuration tests cover provider switching, saved-versus-active state, model discovery authorization, masked keys, unsafe endpoints, and startup without an OpenAI key when Claude is selected. No account credentials or paid generation calls were used during implementation. The portable browser suite includes selecting Ollama and choosing a returned fixture model; it cannot run in this sandbox because sockets/Chromium are restricted.

## Official references checked

- [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)
- [Claude Messages](https://platform.claude.com/docs/en/api/messages/create), [model discovery](https://platform.claude.com/docs/en/api/models/list), and [API versions](https://platform.claude.com/docs/en/api/versioning)
- [Gemini GenerateContent and tool schemas](https://ai.google.dev/api/generate-content) and [model discovery](https://ai.google.dev/api/models)
- [DeepSeek tool calls](https://api-docs.deepseek.com/guides/tool_calls/) and [model discovery](https://api-docs.deepseek.com/api/list-models/)
- [Groq compatibility](https://console.groq.com/docs/openai)
- [OpenRouter API](https://openrouter.ai/docs/api_reference/overview) and [model metadata](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties)
- [Ollama compatibility](https://docs.ollama.com/api/openai-compatibility)
