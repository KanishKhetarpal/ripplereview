import { ArgumentMetadata, BadRequestException, PipeTransform } from '@nestjs/common';
import { ZodType } from 'zod';

/**
 * Validates a request body against a zod schema.
 *
 * Nest's own `ValidationPipe` needs class-validator + class-transformer and decorated DTO
 * classes. The project already validates the environment and every LLM response with zod,
 * and two schema libraries describing the same kinds of shape is how the two definitions
 * drift apart. One library, one story.
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    throw new BadRequestException({
      message: 'Request body failed validation',
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
}
