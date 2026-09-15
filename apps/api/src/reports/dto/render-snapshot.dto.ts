import { IsString, MaxLength } from 'class-validator';

// Fed straight to renderSnapshotPdf -- css is the admin panel's own <style>
// block content (so the snapshot renders with the EXACT same rules the
// screen used, .report-table/.stat-tile/@media print included), and
// bodyHtml is the report view's already-populated DOM (charts pre-converted
// to <img> client-side, since a <canvas> carries no drawn content once
// serialized as HTML). No title here -- the client sets the downloaded
// file's real (Arabic) name itself via the blob download's own `download`
// attribute, same as every other report/dashboard export already does,
// sidestepping Content-Disposition's plain filename="..." not accepting
// non-Latin1 text. Generously bounded, not unlimited -- a real report
// screen's HTML plus a couple of chart PNGs comfortably fits well under
// these limits.
export class RenderSnapshotDto {
  @IsString()
  @MaxLength(300_000)
  css!: string;

  @IsString()
  @MaxLength(8_000_000)
  bodyHtml!: string;
}
