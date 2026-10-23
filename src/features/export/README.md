# export

Selected areas can be exported as one combined PDF (the default), or one PDF per
area inside a ZIP. Both report-content modes and both destinations use the same
generator. The selected project data is loaded once, then PDFs are generated
sequentially without saving inspection records or changing pending sync work.

ZIP filenames include the project, area, report type, and date; duplicate names
get numeric suffixes. An area with no report content still gets a PDF identifying
the area. Generation must finish before the file is downloaded or uploaded, and
failures retain the selection for retry.
