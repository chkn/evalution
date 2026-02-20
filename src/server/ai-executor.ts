import { generateText, streamText } from 'ai';

export class AIExecutor {
  async executePrompt(
    filePath: string,
    functionName: string,
    functionParams: Record<string, any> = {},
    stream: boolean = false
  ): Promise<any> {
    try {
      // Use dynamic import to load the .prompt.ts file
      const module = await import(filePath);
      const promptFunction = module[functionName];

      if (!promptFunction || typeof promptFunction !== 'function') {
        throw new Error(`Function '${functionName}' not found in ${filePath}`);
      }

      // Call the function with provided parameters
      const paramValues = Object.values(functionParams);
      const config = promptFunction(...paramValues);

      if (!config || typeof config !== 'object') {
        throw new Error(`Function '${functionName}' did not return a valid config object`);
      }

      // Execute with AI SDK
      if (stream) {
        return await this.executeStream(config);
      } else {
        return await this.executeGenerate(config);
      }
    } catch (error: any) {
      throw new Error(`Failed to execute prompt: ${error.message}`);
    }
  }

  private async executeGenerate(config: any): Promise<any> {
    try {
      const result = await generateText(config);
      return {
        text: result.text,
        usage: result.usage,
        finishReason: result.finishReason,
      };
    } catch (error: any) {
      throw new Error(`AI generation failed: ${error.message}`);
    }
  }

  private async executeStream(config: any): Promise<AsyncIterable<string>> {
    try {
      const result = await streamText(config);
      return result.textStream;
    } catch (error: any) {
      throw new Error(`AI streaming failed: ${error.message}`);
    }
  }
}
