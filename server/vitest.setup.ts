// Guarantee reflect-metadata is loaded before any spec imports the server
// decorators — DI paramtype reflection depends on it. Idempotent if a spec
// already pulls in @nestjs/core transitively.
import 'reflect-metadata';
