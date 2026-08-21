# Error Codes Reference

> Consolidated from `contracts/docs/UTILITY_ERRORS.md` and `contracts/contracts/utility_contracts/src/ERRORS.md` (issue #308).

## 🌍 IoT-Billing-Service Multi-Language Error Mapping

This document provides a mapping of on-chain error codes to human-readable descriptions in multiple languages. This ensures accessibility for users in rural areas and non-English speaking regions (Issue #122).

### Error Code Reference

| Code | ID | Description | Yoruba | Hausa | Igbo | Spanish | French |
|------|----|-------------|--------|-------|------|---------|--------|
| 1 | `MeterNotFound` | Meter not registered. | A kò rí mita yìí. | Ba a sami mita ba. | Ahụghị mita a. | Medidor no encontrado. | Compteur non trouvé. |
| 5 | `InvalidTokenAmount` | Invalid token amount. | Iye owó kò tọ́. | Adadin kuɗi ba daidai ba. | Ego ezughị oke. | Cantidad de tokens inválida. | Montant de jetons invalide. |
| 11 | `TimestampTooOld` | Transaction expired. | Àkókò ti kọjá. | Lokaci ya ƙare. | Oge agwụla. | Transacción expirada. | Transaction expirée. |
| 15 | `MeterNotPaired` | Device not paired. | Ẹ̀rọ kò tíì so pọ̀. | Ba a haɗa na'ura ba. | Ejikọtaghị mita. | Dispositivo no vinculado. | Appareil non appairé. |
| 16 | `MeterPaused` | Meter is paused. | Mita ti dádúró. | An dakatar da mita. | Akwụsịrị mita a. | Medidor pausado. | Compteur en pause. |
| 19 | `AccountAlreadyClosed` | Account is closed. | Àkàǹtì ti tì. | An rufe asusu. | Emechiela akaụntụ a. | Cuenta ya cerrada. | Compte déjà fermé. |
| 20 | `InsufficientBalance` | Low balance. | Owó kò tó. | Kuɗi ba su isa ba. | Ego ezughị. | Saldo insuficiente. | Solde insuffisant. |
| 22 | `InDispute` | Service in dispute. | Àríyànjiyàn wà. | Akwai jayayya. | E nwere esemokwu. | Servicio en disputa. | Service en litige. |
| 44 | `ProviderNotVerified` | Provider not verified. | Olùpèsè kò fẹsẹ̀ múlẹ̀. | Ba a tabbatar da mai samarwa ba. | Akwadoghị onye na-enye ọrụ. | Proveedor no verificado. | Fournisseur non vérifié. |
| 49 | `InsufficientXlmReserve` | Gas reserve low. | Owó gas kò tó. | Gas ya yi ƙasa. | Ego gas dị ala. | Reserva de gas insuficiente. | Réserve de gas insuffisante. |

### Backend Integration

The backend service should intercept contract reverts, extract the `u32` error code, and look up the corresponding translation based on the user's localized settings.

#### Example Mapping (JSON)
```json
{
  "20": {
    "en": "Insufficient balance to continue service.",
    "yo": "Owó kò tó láti tẹ̀síwájú.",
    "ha": "Kuɗi ba su isa su ci gaba da sabis ba.",
    "ig": "Ego ezughị iji gaa n'ihu.",
    "es": "Saldo insuficiente para continuar el servicio.",
    "fr": "Solde insuffisant pour continuer le service."
  }
}
```

**Last Updated**: March 26, 2026

---

## IoT-Billing-Service Contract - Error Codes

This document provides a mapping of on-chain error codes to user-friendly explanations and suggested actions. When a transaction fails, the frontend can use this guide to display a helpful message instead of a raw error.

| Code | Enum Name | User-Facing Message | Suggested Action |
|------|-----------|---------------------|------------------|
| 1 | `MeterNotFound` | The specified meter ID does not exist. | Please double-check the meter ID you entered. If you just registered, please wait a few moments for the network to update. |
| 2 | `OracleNotSet` | The price oracle has not been configured by the admin. | This is a contract configuration issue. Please contact the service provider. |
| 5 | `InvalidTokenAmount` | The amount for the transaction is invalid (e.g., zero or negative). | Please enter a positive amount for your top-up or withdrawal. |
| 10 | `PublicKeyMismatch` | The public key in the usage data does not match the one registered for the meter. | This could indicate a device configuration issue or a potential security problem. Please contact your utility provider. |
| 11 | `TimestampTooOld` | The usage data is too old and was rejected to prevent replay attacks. | Ensure your metering device's clock is synchronized. The issue should resolve itself on the next reading. |
| 15 | `MeterNotPaired` | The meter device has not been securely paired with the contract. | Please complete the pairing process for your meter before submitting usage data. |
| 19 | `AccountAlreadyClosed` | This meter account has already been closed. | You cannot perform actions on a closed account. Please register a new meter if you wish to continue service. |
| 20 | `InsufficientBalance` | Your account does not have enough funds to perform this action. | Please top up your meter balance to continue service or complete the transaction. |
| 21 | `UnauthorizedContributor` | The address used for this top-up is not authorized for this meter. | Only the meter owner or an authorized contributor (e.g., a roommate) can top up this meter. |
| 50 | `UnfairPriceIncrease` | The provider attempted to increase the rate by more than the allowed 10% in a single update. | The transaction was blocked to protect you from a sudden price spike. No action is needed on your part. |
| 51 | `BillingGroupNotFound` | The specified billing group does not exist. | Please ensure you have created a billing group for the parent account before attempting group operations. |
