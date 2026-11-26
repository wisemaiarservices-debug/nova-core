# NOVA equipment and sensor capability contract v1

This contract describes the capabilities of equipment and sensors without assuming a particular vendor, model or installation.

## Equipment specification

Equipment records are scoped to tenant and site and may describe PV modules, inverters, batteries, meters, pumps, valves, controllers, gateways, weather stations and other assets. Manufacturer, model, serial number, firmware, protocol and ratings are optional. Each rating carries an explicit unit, optional source reference and verification class.

## Sensor capability

A sensor profile declares one or more metrics with explicit units, supported minimum/maximum, resolution, absolute accuracy, sampling interval and output kind. Calibration state and certificate references are distinct from connectivity status.

Supported protocol identifiers are vendor-neutral capability labels only: Modbus TCP/RTU, MQTT, HTTP REST, OPC UA, LoRaWAN, BACnet/IP, CAN bus, serial, manual and unknown. Declaring a protocol does not implement a driver or prove interoperability.

## Registry rules

- Equipment and sensor identifiers are unique within a site registry.
- Every record must match the registry tenant and site.
- A sensor must resolve to a sensor-capable equipment record.
- A sensor marked verified must declare a protocol and a traceable connectivity-evidence reference. This is a caller-supplied reference, not independent proof that the device is online.
- Inventory sizes are bounded (500 equipment records, 1,000 sensors per registry; 100 ratings per equipment and 100 measurements per sensor).
- A caller marking calibration independently verified must provide a certificate reference and consistent dates; the schema does not inspect the certificate or validate the calibration.
- Unknown vendor/model/firmware/calibration/specifications remain unknown.

## Not implemented

No manufacturer catalogue, automatic device discovery, protocol driver, gateway provisioning, credential storage, live sensor ingestion, calibration verification, database persistence, tenant authorization or device connectivity is implemented. A profile is a declared capability contract, not proof that hardware is installed or online.
