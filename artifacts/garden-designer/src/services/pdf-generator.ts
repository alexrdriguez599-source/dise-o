/**
 * PDF Generator — genera cotizaciones profesionales para clientes.
 * Usa jsPDF con diseño limpio tipo empresa.
 */

import jsPDF from "jspdf";

export interface PDFZona {
  nombre: string;
  material: string;
  /** m² area (area-based materials) */
  areaM2: number;
  /** Linear metres perimeter (length-based materials) */
  perimeterM?: number;
  /** "area" = by m², "length" = by ml */
  unitType?: "area" | "length";
  /** Price per unit (m² or ml) */
  pricePerM2: number;
  total: number;
}

export interface PDFProjectData {
  clienteNombre: string;
  clienteTelefono: string;
  clienteEmail: string;
  clienteDireccion: string;
  proyectoNombre: string;
  proyectoFecha: string;
  zonas: PDFZona[];
  plantas: Array<{
    nombre: string;
    cantidad: number;
    precioUnitario: number;
    subtotal: number;
  }>;
  totalCotizacion: number;
  gardenImageData?: string;
  notas?: string;
}

const BRAND_GREEN = [34, 102, 58] as const;
const BRAND_LIGHT = [236, 253, 245] as const;
const TEXT_DARK = [17, 24, 39] as const;
const TEXT_MUTED = [107, 114, 128] as const;

function formatMXN(n: number): string {
  return `$${n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("es-MX", {
      day: "2-digit",
      month: "long",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

export async function generateProjectPDF(data: PDFProjectData): Promise<string> {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  let y = 0;

  // ── Header band ──────────────────────────────────────────────────────────────
  doc.setFillColor(...BRAND_GREEN);
  doc.rect(0, 0, W, 38, "F");

  doc.setTextColor(255, 255, 255);
  doc.setFontSize(22);
  doc.setFont("helvetica", "bold");
  doc.text("Atria", 14, 16);

  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.text("Diseño Profesional de Espacios", 14, 22);

  // Cotización label top-right
  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.text("COTIZACIÓN", W - 14, 14, { align: "right" });
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.text(formatDate(data.proyectoFecha), W - 14, 20, { align: "right" });

  y = 46;

  // ── Client info block ─────────────────────────────────────────────────────────
  doc.setFillColor(...BRAND_LIGHT);
  doc.roundedRect(10, y, W - 20, 30, 3, 3, "F");

  doc.setTextColor(...TEXT_DARK);
  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.text("DATOS DEL CLIENTE", 16, y + 8);

  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(...TEXT_MUTED);

  const leftCol = [
    ["Cliente:", data.clienteNombre],
    ["Teléfono:", data.clienteTelefono],
  ];
  const rightCol = [
    ["Email:", data.clienteEmail || "—"],
    ["Dirección:", data.clienteDireccion],
  ];

  let ry = y + 14;
  leftCol.forEach(([label, val]) => {
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...TEXT_MUTED);
    doc.text(label, 16, ry);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...TEXT_DARK);
    doc.text(val, 36, ry);
    ry += 6;
  });
  ry = y + 14;
  rightCol.forEach(([label, val]) => {
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...TEXT_MUTED);
    doc.text(label, W / 2 + 4, ry);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...TEXT_DARK);
    const trimmed = val.length > 32 ? val.slice(0, 31) + "…" : val;
    doc.text(trimmed, W / 2 + 22, ry);
    ry += 6;
  });

  // Project name
  doc.setFontSize(13);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...BRAND_GREEN);
  y += 38;
  doc.text(`Proyecto: ${data.proyectoNombre}`, 14, y);
  y += 10;

  // ── Garden image ──────────────────────────────────────────────────────────────
  if (data.gardenImageData) {
    try {
      const imgH = 55;
      const imgW = W - 20;
      doc.addImage(data.gardenImageData, "JPEG", 10, y, imgW, imgH, "", "FAST");
      y += imgH + 6;
    } catch {
      // skip image if error
    }
  }

  // ── Zones table ───────────────────────────────────────────────────────────────
  if (data.zonas.length > 0) {
    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...TEXT_DARK);
    doc.text("ZONAS CAD — MATERIALES", 14, y);
    y += 5;

    // Table header
    const colsZ = [55, 22, 22, 28, 28];
    const colXZ = [
      14,
      14 + colsZ[0],
      14 + colsZ[0] + colsZ[1],
      14 + colsZ[0] + colsZ[1] + colsZ[2],
      14 + colsZ[0] + colsZ[1] + colsZ[2] + colsZ[3],
    ];
    doc.setFillColor(...BRAND_GREEN);
    doc.rect(10, y, W - 20, 7, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(8);
    doc.setFont("helvetica", "bold");
    const headersZ = ["Material / Zona", "Área m²", "Perím. ml", "Precio/u.", "Total"];
    headersZ.forEach((h, i) => doc.text(h, colXZ[i] + 2, y + 5));
    y += 7;

    data.zonas.forEach((z, i) => {
      const bg = i % 2 === 0 ? [249, 250, 251] : [255, 255, 255];
      doc.setFillColor(...(bg as [number, number, number]));
      doc.rect(10, y, W - 20, 6.5, "F");
      doc.setTextColor(...TEXT_DARK);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      const isLen = z.unitType === "length";
      const unitLabel = isLen ? "/ml" : "/m²";
      doc.text(z.material.slice(0, 26), colXZ[0] + 2, y + 4.5);
      doc.text(z.areaM2.toFixed(1), colXZ[1] + 2, y + 4.5);
      doc.text(z.perimeterM !== undefined ? z.perimeterM.toFixed(1) : "—", colXZ[2] + 2, y + 4.5);
      doc.text(`${formatMXN(z.pricePerM2)}${unitLabel}`, colXZ[3] + 2, y + 4.5);
      doc.text(formatMXN(z.total), colXZ[4] + 2, y + 4.5);
      y += 6.5;
    });
    y += 4;
  }

  // ── Plants table ──────────────────────────────────────────────────────────────
  if (data.plantas.length > 0) {
    // Check if we need a new page
    if (y > H - 70) {
      doc.addPage();
      y = 20;
    }

    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...TEXT_DARK);
    doc.text("PLANTAS Y ELEMENTOS", 14, y);
    y += 5;

    const colsP = [72, 20, 28, 28];
    const colXP = [14, 14 + colsP[0], 14 + colsP[0] + colsP[1], 14 + colsP[0] + colsP[1] + colsP[2]];
    doc.setFillColor(...BRAND_GREEN);
    doc.rect(10, y, W - 20, 7, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(8);
    doc.setFont("helvetica", "bold");
    const headersP = ["Elemento", "Cant.", "Precio unit.", "Subtotal"];
    headersP.forEach((h, i) => doc.text(h, colXP[i] + 2, y + 5));
    y += 7;

    data.plantas.forEach((p, i) => {
      const bg = i % 2 === 0 ? [249, 250, 251] : [255, 255, 255];
      doc.setFillColor(...(bg as [number, number, number]));
      doc.rect(10, y, W - 20, 6.5, "F");
      doc.setTextColor(...TEXT_DARK);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.text(p.nombre.slice(0, 34), colXP[0] + 2, y + 4.5);
      doc.text(String(p.cantidad), colXP[1] + 2, y + 4.5);
      doc.text(formatMXN(p.precioUnitario), colXP[2] + 2, y + 4.5);
      doc.text(formatMXN(p.subtotal), colXP[3] + 2, y + 4.5);
      y += 6.5;
    });
    y += 4;
  }

  // ── Totals ────────────────────────────────────────────────────────────────────
  if (y > H - 40) { doc.addPage(); y = 20; }

  doc.setFillColor(...BRAND_GREEN);
  doc.rect(W - 90, y, 80, 14, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.text("TOTAL COTIZACIÓN:", W - 88, y + 6);
  doc.setFontSize(13);
  doc.text(formatMXN(data.totalCotizacion), W - 88, y + 12.5);
  y += 20;

  // ── Notes ─────────────────────────────────────────────────────────────────────
  if (data.notas) {
    doc.setFontSize(9);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...TEXT_MUTED);
    doc.text("NOTAS:", 14, y);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...TEXT_DARK);
    const lines = doc.splitTextToSize(data.notas, W - 28);
    doc.text(lines, 14, y + 6);
    y += 6 + lines.length * 5;
  }

  // ── Footer ────────────────────────────────────────────────────────────────────
  doc.setFillColor(...BRAND_GREEN);
  doc.rect(0, H - 14, W, 14, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.text("Atria · Diseño Profesional de Espacios", W / 2, H - 5, { align: "center" });
  doc.text(`Generado el ${formatDate(new Date().toISOString())}`, 14, H - 5);

  return doc.output("datauristring");
}
