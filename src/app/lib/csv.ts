/** Escape one CSV cell: wrap in quotes, double any embedded quotes. */
const cell = (value: unknown) => {
  const text = value === null || value === undefined ? '' : String(value)
  return `"${text.replace(/"/g, '""')}"`
}

/** Build a CSV document from header + rows and trigger a browser download. */
export function downloadCsv(filename: string, header: string[], rows: unknown[][]) {
  const body = [header, ...rows].map((line) => line.map(cell).join(',')).join('\r\n')
  const blob = new Blob([`\ufeff${body}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}
