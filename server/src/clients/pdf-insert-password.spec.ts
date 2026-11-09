import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { PdfSdkClient } from './pdf-sdk.client';
import { UpstreamSdkError } from '../common/errors/upstream-sdk.error';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';
const source = { originalname: 'source.pdf', buffer: Buffer.from('%PDF source') };
const insert = { ...source, originalname: 'insert.pdf' };
const result = { buffer: Buffer.from('%PDF result'), headers: {} };
function sdkError(code = 120002, origin: 'pdf' | 'conversion' = 'pdf') {
  return new UpstreamSdkError({ source: origin, status: 400, code, message: 'PDF password error', traceId: 'insert-trace' });
}
function fixture() {
  const client = new PdfSdkClient({ get: () => 'http://unused' } as unknown as ConfigService);
  return { client, call: vi.spyOn(client as any, 'callSync').mockResolvedValue(result) };
}
describe('PDF insertion password provenance', () => {
  it('does not add probes to successful insertions', async () => {
    const { client, call } = fixture();
    await expect(client.insertFromPdf(source, insert, {}, '')).resolves.toBe(result);
    expect(call).toHaveBeenCalledTimes(1);
  });
  it.each([
    { main: 120002, other: 0, location: 'source' },
    { main: 0, other: 120002, location: 'insert' },
    { main: 120001, other: 120002, location: 'both' },
    { main: 0, other: 120001, location: 'insert' },
  ])('identifies $location', async ({ main, other, location }) => {
    const { client, call } = fixture();
    call.mockRejectedValueOnce(sdkError());
    if (main) call.mockRejectedValueOnce(sdkError(main)); else call.mockResolvedValueOnce(result);
    if (other) call.mockRejectedValueOnce(sdkError(other)); else call.mockResolvedValueOnce(result);
    let caught: unknown;
    try { await client.insertFromPdf(source, insert, { password: 'main-secret', insertPassword: 'insert-secret' }, 'token'); }
    catch (error) { caught = error; }
    const response = AllExceptionsFilter.toResponse(caught);
    expect(response).toMatchObject({ statusCode: 200, body: { type: 'pdf', code: 120002, traceId: 'insert-trace', errorCode: 'INVALID_PASSWORD', passwordSource: location } });
    expect(JSON.stringify(response)).not.toContain('secret');
    expect(call).toHaveBeenNthCalledWith(2, '/v1/sync/documents/info', [expect.objectContaining({ fieldname: 'file', originalname: 'source.pdf' })], { password: 'main-secret' }, 'token');
    expect(call).toHaveBeenNthCalledWith(3, '/v1/sync/documents/info', [expect.objectContaining({ fieldname: 'file', originalname: 'insert.pdf' })], { password: 'insert-secret' }, 'token');
  });
  it.each([0, 100101, 130011, 190006])('retains original errors when probes cannot confirm passwords (%s)', async (code) => {
    const { client, call } = fixture();
    const original = sdkError();
    call.mockRejectedValueOnce(original).mockRejectedValue(sdkError(code));
    await expect(client.insertFromPdf(source, insert, {}, '')).rejects.toBe(original);
    expect(call.mock.calls[1][2]).toEqual({});
    expect(call.mock.calls[2][2]).toEqual({});
  });
  it('does not guess when both documents open successfully', async () => {
    const { client, call } = fixture(); const original = sdkError();
    call.mockRejectedValueOnce(original);
    await expect(client.insertFromPdf(source, insert, {}, '')).rejects.toBe(original);
  });
  it.each([sdkError(100101), sdkError(130011), sdkError(120002, 'conversion'), new Error('network')])('does not probe unrelated failures', async (original) => {
    const { client, call } = fixture(); call.mockRejectedValueOnce(original);
    await expect(client.insertFromPdf(source, insert, {}, '')).rejects.toBe(original);
    expect(call).toHaveBeenCalledTimes(1);
  });
});
