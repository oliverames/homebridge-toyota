// Synthetic payloads shaped like the responses RedLink parses. Not captured data.

export const vehicleList = {
  status: 'SUCCESS',
  payload: [
    {
      vin: 'TESTVIN0000000001',
      nickName: 'TESTVIN0000000001',
      modelName: 'bZ Woodland',
      modelYear: '2026',
      generation: '21MM',
      evVehicle: true,
      remoteServiceCapabilities: { remoteStart: true, doorLock: { supported: true }, sunroof: false },
      subscriptions: [{ serviceName: 'Remote Connect', subscriptionStatus: 'ACTIVE', subscriptionRemainingDays: 120 }],
    },
    { vin: 'TESTVIN0000000002', nickName: 'Daily', modelName: 'Tacoma', modelYear: '2025' },
  ],
};

function section(name: string, ...values: string[]) {
  return { category: name, sections: [{ section: name, values: values.map((value) => ({ value })) }] };
}

export function remoteStatus(opts: { driverLocked?: boolean; passengerOpen?: boolean; hatchOpen?: boolean } = {}) {
  const { driverLocked = true, passengerOpen = false, hatchOpen = false } = opts;
  return {
    status: 'SUCCESS',
    payload: {
      vehicleStatus: [
        section('Driver Side Door', 'closed', driverLocked ? 'locked' : 'unlocked'),
        section('Passenger Side Door', passengerOpen ? 'open' : 'closed', 'locked'),
        section('Rear Hatch', hatchOpen ? 'open' : 'closed', 'locked'),
        section('Driver Side Window', 'closed'),
        section('Hood', 'closed'),
      ],
    },
  };
}

export const electricCharging = {
  payload: { vehicleInfo: { chargeInfo: { chargeRemainingAmount: 64, connectorStatus: 5, chargeType: 15, plugStatus: 40, remainingChargeTime: 95 } } },
};
export const electricIdle = {
  payload: { vehicleInfo: { chargeInfo: { chargeRemainingAmount: 18, connectorStatus: 0, chargeType: 0, remainingChargeTime: 65535 } } },
};
