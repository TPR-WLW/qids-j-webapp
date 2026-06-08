from __future__ import annotations

import csv
from pathlib import Path
from typing import Iterable, TextIO

from .records import CSV_FIELDS, EcgRecord


class CsvSampleWriter:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self._file: TextIO | None = None
        self._writer: csv.DictWriter | None = None

    def __enter__(self) -> "CsvSampleWriter":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        needs_header = not self.path.exists() or self.path.stat().st_size == 0
        self._file = self.path.open("a", newline="", encoding="utf-8")
        self._writer = csv.DictWriter(self._file, fieldnames=CSV_FIELDS)
        if needs_header:
            self._writer.writeheader()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if self._file:
            self._file.close()
        self._file = None
        self._writer = None

    def write(self, record: EcgRecord) -> None:
        if not self._writer:
            raise RuntimeError("CsvSampleWriter is not open")
        self._writer.writerow(record.to_csv_row())

    def write_many(self, records: Iterable[EcgRecord]) -> int:
        count = 0
        for record in records:
            self.write(record)
            count += 1
        return count
