# GDS accessibility tool audit: WAVE and axe results per test case

Source: https://alphagov.github.io/accessibility-tool-audit/results.html (data repo: https://github.com/alphagov/accessibility-tool-audit). Test cases: https://alphagov.github.io/accessibility-tool-audit/test-cases.html.
Fetched: 2026-10-24. The audit page says its results were last updated 13 April 2018 (WAVE re-tested then), so the axe column reflects the axe of 2018, not the axe-core 4.14 that HARgus bundles.

The results are published only as an HTML table (the repo has no data file), so the WAVE and axe columns below were parsed from that table, one row per test case (142 cases). Values are the page's own labels:

- WAVE: Issue found, Warning only, Noticed but not a fail, User to check, Not found.
- axe: Issue found, User to check, Not found.

Totals: WAVE found 25 as an issue, 18 as a warning only and 2 as noticed (45 reported something), plus 12 "user to check". axe found 41 as an issue plus 2 "user to check".

Some cases (lang, page title, missing H1, keyboard trap, chunking) are demonstrated by separate example pages that the aggregate test page only links to. The calibration in gds-harg-calibration.md did not read those.

| # | Test case | WAVE | axe |
|---|---|---|---|
| 1 | Content identified by location | Not found | Not found |
| 2 | Plain language is not used | Not found | Not found |
| 3 | Content is not in correct reading order in source code | Not found | Not found |
| 4 | Content is not organised into well-defined groups or chunks, using headings, lists, and other visual mechanisms | Not found | Not found |
| 5 | First instance of abbreviation not expanded | Not found | Not found |
| 6 | Wide page forces users to scroll horizontally | Not found | Not found |
| 7 | Colour alone is used to convey content | Not found | Not found |
| 8 | Small text does not have a contrast ratio of at least 4.5:1 so does not meet AA | Issue found | Issue found |
| 9 | Large text does not have a contrast ratio of at least 3:1 so does not meet AA | Issue found | Issue found |
| 10 | Small text does not have a contrast ratio of at least 7:1 so does not meet AAA | Issue found | Issue found |
| 11 | Large text does not have a contrast ratio of at least 4.5:1 so does not meet AAA | Issue found | Issue found |
| 12 | Focus not visible | Not found | Not found |
| 13 | Inadequate line height used | Not found | Not found |
| 14 | All caps text found | Not found | Not found |
| 15 | Blink element found | Issue found | Issue found |
| 16 | Italics used on long sections of text | Not found | Not found |
| 17 | Marquee element found | Issue found | Issue found |
| 18 | Long lines of text | Not found | Not found |
| 19 | Very small text found | Warning only | Not found |
| 20 | Justified text found | Warning only | Not found |
| 21 | Text language changed without required change in direction | Not found | Not found |
| 22 | html element has an empty lang attribute | Not found | Issue found |
| 23 | lang attribute not used to identify change of language | Not found | Not found |
| 24 | Text language is in the wrong direction | Not found | Not found |
| 25 | html element has an invalid value in the lang attribute | Not found | Issue found |
| 26 | lang attribute used to identify change of language, but with invalid value | User to check | Issue found |
| 27 | html element is missing a lang attribute | Issue found | Issue found |
| 28 | html element has lang attribute set to wrong language | Not found | Not found |
| 29 | lang attribute used to identify change of language, but with wrong language | Not found | Not found |
| 30 | Inappropriate page title | Not found | Not found |
| 31 | Empty page title | Issue found | Issue found |
| 32 | Missing page title | Issue found | Issue found |
| 33 | Empty heading | Issue found | Issue found |
| 34 | Missing H1 | Warning only | Not found |
| 35 | Text formatting used instead of an actual heading | Not found | Not found |
| 36 | Headings not structured in a hierarchical manner | Warning only | Issue found |
| 37 | LI element with no parent | Not found | Issue found |
| 38 | List not marked up as a list | Not found | Not found |
| 39 | DT or DD elements that are not contained within a DL element | Not found | Issue found |
| 40 | Improperly nested lists | Not found | Issue found |
| 41 | Table with column headers and double row headers | User to check | Not found |
| 42 | Table has no scope attributes | User to check | Not found |
| 43 | Table nested within table header | Not found | Not found |
| 44 | Table nested within table | Not found | Not found |
| 45 | Table has no table headings | User to check | Issue found |
| 46 | Table with inconsistent numbers of columns in rows | Not found | Not found |
| 47 | Table that only has TH elements in it | Not found | Issue found |
| 48 | Table is missing a caption | User to check | Not found |
| 49 | Table used for layout | Noticed but not a fail | Not found |
| 50 | Table has an empty table header | Issue found | Not found |
| 51 | Table with some empty cells | Not found | Not found |
| 52 | Image has alt and title that are different | Not found | Not found |
| 53 | Image with presentation role has non-empty alt | Not found | Not found |
| 54 | Image with no alt attribute | Issue found | Issue found |
| 55 | Background image that conveys information does not have a text alternative | Not found | Not found |
| 56 | Image has empty alt and non-empty title | Not found | Not found |
| 57 | A distraction is present, an animated gif | Not found | Not found |
| 58 | Image that conveys information has an empty alt attribute | User to check | Not found |
| 59 | Image that conveys information has inappropriate alt text | User to check | Not found |
| 60 | Image alt attribute contains image file name | Warning only | Not found |
| 61 | Image with partial text alternative | User to check | Not found |
| 62 | Embedded video file is missing text alternative | User to check | User to check |
| 63 | Flashing content doesn't have warning | Not found | Not found |
| 64 | Embedded audio file is missing text alternative | User to check | User to check |
| 65 | Image link with no alternative text | Issue found | Issue found |
| 66 | Link to javascript, invalid hypertext reference | Not found | Not found |
| 67 | Uninformative link text | Warning only | Not found |
| 68 | Link launches new window with no warning | Not found | Not found |
| 69 | Links not separated by printable characters | Not found | Not found |
| 70 | Link text with identical title | Warning only | Not found |
| 71 | Links to a sound file, no transcript | Warning only | Not found |
| 72 | Identifying links by colour alone | Not found | Not found |
| 73 | Link to PDF does not include information on file format and file size | Warning only | Not found |
| 74 | Link to #, invalid hypertext reference | Not found | Issue found |
| 75 | Blank link text | Issue found | Issue found |
| 76 | Links with the same text go to different pages | Not found | Not found |
| 77 | Link text does not make sense out of context | Not found | Not found |
| 78 | Adjacent links going to the same destination | Warning only | Not found |
| 79 | Link contains only a full stop | Not found | Not found |
| 80 | Image link alt text repeats text in the link | Warning only | Issue found |
| 81 | Link not clearly identifiable and distinguishable from surrounding text | Not found | Not found |
| 82 | Link to a multimedia file, no transcript | Warning only | Not found |
| 83 | Non-specific link text | Warning only | Not found |
| 84 | Link to an image, no text alternative | Not found | Not found |
| 85 | Image button has no alt attribute | Issue found | Issue found |
| 86 | Empty button | Issue found | Issue found |
| 87 | Uninformative alt attribute value on image button | User to check | Not found |
| 88 | Empty alt attribute on image button | Issue found | Issue found |
| 89 | Errors identified by colour only | Not found | Not found |
| 90 | Labels missing when they would look clumsy for some form controls | Issue found | Issue found |
| 91 | Error messages - no suggestion for corrections given, e.g. required format | Not found | Not found |
| 92 | Left aligned form labels with too much white space | Not found | Not found |
| 93 | Group of radio buttons not enclosed in a fieldset | Warning only | Issue found |
| 94 | Form element has no label | Issue found | Issue found |
| 95 | Fieldset without a legend | Warning only | Not found |
| 96 | Empty legend | Not found | Not found |
| 97 | Label element with for= attribute but not matching id= attribute of form control | Issue found | Issue found |
| 98 | Group of check boxes not enclosed in a fieldset | Warning only | Issue found |
| 99 | Empty label found | Issue found | Issue found |
| 100 | Two unique labels, but identical for= attributes | Issue found | Issue found |
| 101 | Errors identified with a poor colour contrast | Issue found | Issue found |
| 102 | Non-unique field label found | Not found | Not found |
| 103 | Missing labels in checkboxes | Issue found | Issue found |
| 104 | Field hint not associated with input | Not found | Not found |
| 105 | Placeholder no label | Issue found | Issue found |
| 106 | Errors are not identified | Not found | Not found |
| 107 | Form control that changes context without warning | Not found | Not found |
| 108 | Inadequately-sized clickable targets found | Not found | Not found |
| 109 | Alert shows for a short time | Not found | Not found |
| 110 | Lightbox - close button doesn't receive focus | Not found | Not found |
| 111 | Focus order in wrong order | Not found | Not found |
| 112 | Tabindex greater than 0 | Warning only | Issue found |
| 113 | Keyboard focus is not indicated visually | Not found | Not found |
| 114 | Keyboard focus assigned to a non focusable element using tabindex=0 | User to check | Not found |
| 115 | Concertina items don't get keyboard focus | Not found | Not found |
| 116 | Keyboard trap | Not found | Not found |
| 117 | Dropdown navigation - only the top level items receive focus | Not found | Not found |
| 118 | Lightbox - ESC key doesn't close the lightbox | Not found | Not found |
| 119 | Link with a role=button does not work with space bar | Not found | Not found |
| 120 | Tooltips don't receive keyboard focus | Not found | Not found |
| 121 | Accesskey attribute used | Warning only | Not found |
| 122 | Lightbox - focus is not moved immediately to lightbox | Not found | Not found |
| 123 | Lightbox - focus is not retained within the lightbox | Not found | Not found |
| 124 | Fake button is not keyboard accessible | Not found | Not found |
| 125 | iframe is missing a title attribute | Not found | Issue found |
| 126 | iframe title attribute does not describe the content or purpose of the iframe | Not found | Not found |
| 127 | Content is not readable and functional when text is increased | Not found | Not found |
| 128 | Non-decorative content inserted using CSS | Not found | Not found |
| 129 | visibility:hidden used to visually hide content when it should be available to screenreader | Not found | Not found |
| 130 | display:none used to visually hide content when it should be available to screenreader | Not found | Not found |
| 131 | Page zoom - boxes that don't expand with the text | Not found | Not found |
| 132 | Duplicate id | Not found | Issue found |
| 133 | Article element used to mark-up an element that's not an article/blog post etc. | Not found | Not found |
| 134 | Empty paragraph | Not found | Not found |
| 135 | Deprecated center element | Not found | Not found |
| 136 | Invalid ARIA role names | Not found | Issue found |
| 137 | Object not embedded accessibly - wmode parameter not set to window | Not found | Not found |
| 138 | Spacer image found | Noticed but not a fail | Not found |
| 139 | Inline style adds colour | Not found | Not found |
| 140 | Start and close tags don't match | Not found | Not found |
| 141 | PRE element without CODE element inside it | Not found | Not found |
| 142 | Deprecated font element | Not found | Not found |
