# TARX Voice Pronunciation Rules

Updated: 2026-05-16

## System Rule

Write and display the brand as **TARX**. Speak and pronounce it as **TARS**.

This applies to:

- TTS prompt normalization
- Daniel/Kokoro voice QA
- Spoken scripts
- Voice acceptance tests
- STT semantic acceptance for wake/check-in phrases

## Canonical Examples

| Written | Spoken |
| --- | --- |
| TARX is listening. | TARS is listening. |
| Go ahead, TARX. | Go ahead, TARS. |
| TARX, what are we working on today? | TARS, what are we working on today? |

## QA Requirement

Daniel voice review must score TARX vocabulary pronunciation against the spoken form **TARS**. A voice sample that says individual letters, sounds like “tar-ex,” or otherwise fails the **TARS** pronunciation cannot pass the brand gate.
