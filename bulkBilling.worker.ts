import { prisma } from '../db';
// import { queue } from '../lib/redis'; // Za mu yi shi da gaske daga baya

export async function queueBulkInvoice(jobId: string, userId: string, reqIp: string) {
  await processBulkInvoiceJob(jobId, userId, reqIp);
}

export async function processBulkInvoiceJob(jobId: string, userId: string, reqIp: string) {
  const startTime = Date.now(); // MONITORING START
  
  try {
    await prisma.bulkJob.update({ where: { id: jobId }, data: { status: 'running' } });

    const job = await prisma.bulkJob.findUnique({ 
      where: { id: jobId }, 
      include: { group: { include: { members: true } } }
    });
    if (!job) throw new Error('Job not found');

    // AUDIT LOG - SOC2/PCI-DSS
    await prisma.auditLog.create({
      data: {
        action: 'BULK_INVOICE_CREATED',
        userId: userId,
        targetId: job.groupId,
        targetType: 'DeviceGroup',
        details: { deviceCount: job.group.members.length },
        ipAddress: reqIp,
        createdAt: new Date()
      }
    });

    // Logic: ga kowane device a group, ƙirƙiri BillingRecord
    for (const member of job.group.members) {
      await prisma.billingRecord.create({
        data: {
          deviceId: member.deviceId,
          accountId: job.group.ownerId,
          usageAmount: BigInt(100), // na gwaji ne
          status: 'pending'
        }
      });
    }

    const duration = Date.now() - startTime; // MONITORING END
    
   
