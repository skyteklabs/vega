# /// script
# requires-python = ">=3.10"
# dependencies = ["python-docx>=1.1"]
# ///
"""Build the placeholder SOW template (assets/sow-template.docx).

Every docxtpl tag is written as a single run, so Word never splits it.
Once SkyTek has its own branded template, edit that in Word instead and
stop regenerating this one.

    uv run build_template.py [--out PATH]
"""

import argparse
from pathlib import Path

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor

ACCENT = RGBColor(0x1F, 0x3A, 0x5F)
DEFAULT_OUT = Path(__file__).resolve().parent.parent / "assets" / "sow-template.docx"


def shade(cell, hex_fill):
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), hex_fill)
    tc_pr.append(shd)


def heading(doc, text, level=1):
    h = doc.add_heading(text, level=level)
    for run in h.runs:
        run.font.color.rgb = ACCENT
    return h


def bullets(doc, var, empty_text=None):
    """A {%p for %} bullet list over `var`, with an optional fallback line."""
    if empty_text:
        doc.add_paragraph(f"{{%p if {var} %}}")
    doc.add_paragraph(f"{{%p for item in {var} %}}")
    doc.add_paragraph("{{ item }}", style="List Bullet")
    doc.add_paragraph("{%p endfor %}")
    if empty_text:
        doc.add_paragraph("{%p else %}")
        doc.add_paragraph(empty_text)
        doc.add_paragraph("{%p endif %}")


def loop_table(doc, headers, loop, cells, total=None):
    """Header row, then {%tr for %} / data / {%tr endfor %} rows, then an optional total row."""
    # Rows: header, {%tr for %}, data, {%tr endfor %}, then the total if any.
    # docxtpl drops the two tag rows and repeats the data row.
    table = doc.add_table(rows=5 if total else 4, cols=len(headers))
    table.style = "Table Grid"
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    for i, text in enumerate(headers):
        cell = table.rows[0].cells[i]
        run = cell.paragraphs[0].add_run(text)
        run.bold = True
        run.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
        shade(cell, "1F3A5F")
    table.rows[1].cells[0].text = f"{{%tr for {loop} %}}"
    for i, text in enumerate(cells):
        table.rows[2].cells[i].text = text
    table.rows[3].cells[0].text = "{%tr endfor %}"
    if total:
        for i, text in enumerate(total):
            table.rows[4].cells[i].paragraphs[0].add_run(text).bold = True
    return table


def build(out: Path):
    doc = Document()
    normal = doc.styles["Normal"]
    normal.font.name = "Calibri"
    normal.font.size = Pt(11)

    footer = doc.sections[0].footer.paragraphs[0]
    footer.text = "{{ vendor_name }} · Scope of Work · {{ project_title }} · Confidential"
    footer.alignment = WD_ALIGN_PARAGRAPH.CENTER
    footer.runs[0].font.size = Pt(8)

    # Cover
    title = doc.add_paragraph()
    title.alignment = WD_ALIGN_PARAGRAPH.LEFT
    run = title.add_run("Scope of Work")
    run.bold = True
    run.font.size = Pt(32)
    run.font.color.rgb = ACCENT
    sub = doc.add_paragraph()
    run = sub.add_run("{{ project_title }}")
    run.font.size = Pt(18)
    doc.add_paragraph("Prepared for {{ client_name }}")
    doc.add_paragraph("{{ client_address }}")
    doc.add_paragraph("Prepared by {{ vendor_name }}")
    doc.add_paragraph("{{ vendor_address }}")
    doc.add_paragraph("Date: {{ sow_date }}")
    doc.add_paragraph("Version: {{ version }}")
    doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)

    heading(doc, "1. Background")
    doc.add_paragraph("{{ background }}")

    heading(doc, "2. Objectives")
    bullets(doc, "objectives")

    heading(doc, "3. Scope")
    heading(doc, "3.1 In scope", level=2)
    bullets(doc, "in_scope")
    heading(doc, "3.2 Out of scope", level=2)
    bullets(doc, "out_of_scope", empty_text="No exclusions specified.")

    heading(doc, "4. Deliverables")
    loop_table(
        doc,
        ["#", "Deliverable", "Description", "Due"],
        "d in deliverables",
        ["{{ loop.index }}", "{{ d.name }}", "{{ d.description }}", "{{ d.due }}"],
    )

    heading(doc, "5. Timeline and milestones")
    doc.add_paragraph("The work runs from {{ start_date }} to {{ end_date }}.")
    loop_table(
        doc,
        ["Milestone", "Target date", "Description"],
        "m in milestones",
        ["{{ m.name }}", "{{ m.date }}", "{{ m.description }}"],
    )

    heading(doc, "6. Roles and responsibilities")
    doc.add_paragraph("{%p if roles %}")
    loop_table(
        doc,
        ["Party", "Responsibility"],
        "r in roles",
        ["{{ r.party }}", "{{ r.responsibility }}"],
    )
    doc.add_paragraph("{%p else %}")
    doc.add_paragraph("Each party's responsibilities are as described in this SOW.")
    doc.add_paragraph("{%p endif %}")

    heading(doc, "7. Assumptions")
    bullets(doc, "assumptions", empty_text="No assumptions specified.")

    heading(doc, "8. Acceptance criteria")
    doc.add_paragraph("{{ acceptance_criteria }}")

    heading(doc, "9. Fees and payment")
    doc.add_paragraph("Pricing model: {{ pricing_model }}. All amounts in {{ currency }}.")
    loop_table(
        doc,
        ["Item", "Amount"],
        "f in fees",
        ["{{ f.item }}", "{{ f.amount }}"],
        total=["Total", "{{ total_fees }}"],
    )
    doc.add_paragraph()
    loop_table(
        doc,
        ["Payment milestone", "Invoice date", "Amount"],
        "p in payment_schedule",
        ["{{ p.milestone }}", "{{ p.due }}", "{{ p.amount }}"],
    )
    doc.add_paragraph("Payment terms: {{ payment_terms }}.")

    heading(doc, "10. Change control")
    doc.add_paragraph("{{ change_control }}")

    heading(doc, "11. Term")
    doc.add_paragraph(
        "This SOW takes effect on {{ start_date }} and ends on {{ end_date }} "
        "or when all deliverables are accepted, whichever is later."
    )
    doc.add_paragraph(
        "{% if governing_law %}This SOW is governed by the laws of {{ governing_law }}.{% endif %}"
    )

    heading(doc, "12. Signatures")
    sig = doc.add_table(rows=5, cols=2)
    sig.style = "Table Grid"
    rows = [
        ("For {{ vendor_name }}", "For {{ client_name }}"),
        ("Signature:", "Signature:"),
        ("Name: {{ vendor_signatory_name }}", "Name: {{ client_signatory_name }}"),
        ("Title: {{ vendor_signatory_title }}", "Title: {{ client_signatory_title }}"),
        ("Date:", "Date:"),
    ]
    for r, (left, right) in enumerate(rows):
        sig.rows[r].cells[0].text = left
        sig.rows[r].cells[1].text = right
    for cell in sig.rows[0].cells:
        cell.paragraphs[0].runs[0].bold = True

    out.parent.mkdir(parents=True, exist_ok=True)
    doc.save(out)
    return out


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    print(build(parser.parse_args().out))
