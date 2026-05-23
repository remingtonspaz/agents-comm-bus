export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface ToolRegistry {
  register(name: string, descriptor: ToolDescriptor): void;
  list(): ToolDescriptor[];
  get(name: string): ToolDescriptor | undefined;
}
