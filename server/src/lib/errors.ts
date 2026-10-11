/** Erro de aplicação com status HTTP, código estável e mensagem para o usuário. */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, 'BAD_REQUEST', message, details);
export const validationError = (message: string, details?: unknown) =>
  new AppError(422, 'VALIDATION_ERROR', message, details);
export const unauthorized = (message = 'Autenticação necessária.') => new AppError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'Você não possui permissão para realizar esta operação.') =>
  new AppError(403, 'FORBIDDEN', message);
/** Usado para recursos que o usuário não pode ver: não revela a existência do recurso. */
export const notFound = (message = 'Recurso não encontrado.') => new AppError(404, 'NOT_FOUND', message);
export const conflict = (code: string, message: string, details?: unknown) => new AppError(409, code, message, details);
export const tooLarge = (message: string) => new AppError(413, 'PAYLOAD_TOO_LARGE', message);
export const unsupported = (message: string) => new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', message);
export const serviceUnavailable = (code: string, message: string) => new AppError(503, code, message);
