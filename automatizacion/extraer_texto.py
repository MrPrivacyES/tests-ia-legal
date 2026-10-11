#!/usr/bin/env python3
"""Extrae el texto de un .docx en orden de lectura, incluido el texto con color blanco.

Es lo que ve cualquier modelo al que se le entrega el documento ya convertido a texto:
la inyección (blanco sobre blanco) va incluida. Imprime el texto por stdout y, por stderr,
las tiradas ocultas detectadas, para comprobar que la frase sigue presente.
Uso: python3 -I extraer_texto.py contrato.docx > contrato.txt
"""
import sys
import zipfile
from xml.etree import ElementTree as ET

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def es_blanco(run):
    color = run.find(f"{W}rPr/{W}color")
    return color is not None and color.get(f"{W}val", "").upper() == "FFFFFF"


def main(ruta):
    raiz = ET.fromstring(zipfile.ZipFile(ruta).read("word/document.xml"))
    parrafos, ocultos = [], []
    for p in raiz.iter(f"{W}p"):
        partes = []
        for r in p.iter(f"{W}r"):
            texto = "".join(
                "\t" if n.tag == f"{W}tab" else "\n" if n.tag == f"{W}br" else (n.text or "")
                for n in r
                if n.tag in (f"{W}t", f"{W}tab", f"{W}br")
            )
            partes.append(texto)
            if texto.strip() and es_blanco(r):
                ocultos.append(texto.strip())
        parrafos.append("".join(partes))
    print("\n".join(parrafos))
    for t in ocultos:
        print(f"[texto blanco detectado] {t}", file=sys.stderr)
    if not ocultos:
        print("[aviso] no se ha detectado texto blanco en el documento", file=sys.stderr)


main(sys.argv[1])
